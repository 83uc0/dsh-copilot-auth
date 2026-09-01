import { createUserMessage, type GenerateOptions, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { GitHubCopilotAdapter } from '../src/adapter.js'
import { AsyncQueue } from '../src/async-queue.js'
import type {
  ActiveRuntimeCall,
  CopilotRuntime,
  RuntimeAuthStatus,
  RuntimeCallRequest,
  RuntimeEvent,
  RuntimeModel,
  RuntimeUsageData,
} from '../src/copilot-runtime.js'
import { ConsumptionTracker, type InputConventionConfig } from '../src/usage-tracker.js'

const MODEL: RuntimeModel = {
  id: 'gpt-5.4',
  name: 'GPT-5.4',
  enabled: true,
  contextWindow: 272_000,
  vision: false,
  reasoningEfforts: [],
}

class MockCall implements ActiveRuntimeCall {
  readonly queue = new AsyncQueue<RuntimeEvent>()
  disposed = false

  get events(): AsyncIterable<RuntimeEvent> {
    return this.queue
  }

  async respondToTool(): Promise<void> {}
  async abort(): Promise<void> {}
  async dispose(): Promise<void> {
    this.disposed = true
    this.queue.close()
  }
}

class MockRuntime implements CopilotRuntime {
  readonly calls: MockCall[] = []

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async getAuthStatus(): Promise<RuntimeAuthStatus> {
    return { isAuthenticated: true, login: 'octocat' }
  }
  async listModels(): Promise<readonly RuntimeModel[]> {
    return [MODEL, { ...MODEL, id: 'auto', name: 'Auto' }]
  }
  async startCall(_request: RuntimeCallRequest): Promise<ActiveRuntimeCall> {
    const call = this.calls.shift()
    if (call === undefined) throw new Error('No mock call queued')
    return call
  }
}

function options(model = 'gpt-5.4'): GenerateOptions {
  const messages: Message[] = [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })]
  return { provider: 'github-copilot', model, messages, tools: [] }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function usage(overrides: Partial<RuntimeUsageData> & { model: string }): RuntimeUsageData {
  return { ...overrides }
}

function usageChunk(chunks: StreamChunk[]): Extract<StreamChunk, { type: 'usage' }> | undefined {
  return chunks.find((chunk): chunk is Extract<StreamChunk, { type: 'usage' }> => chunk.type === 'usage')
}

interface ReplayUsagePayload {
  copilotUsage: {
    version: number
    requestedModel: string
    usageObserved: boolean
    tokens: unknown
    calls: readonly RuntimeUsageData[]
    models: readonly {
      model: string
      calls: number
      nanoAiu: number | null
      estimatedCredits: number | null
      pricing: 'known' | 'unknown'
    }[]
    modelChanges: readonly { newModel: string; cause?: string }[]
    nanoAiuTotal: number | null
    estimate: null | {
      source: string
      totalCredits: number
      totalUsd: number
      perModel: readonly { model: string; credits: number }[]
      unknownModels: readonly string[]
    }
  }
}

function replayUsage(chunks: StreamChunk[]): ReplayUsagePayload['copilotUsage'] | undefined {
  const finish = chunks.find((chunk) => chunk.type === 'finish')
  if (finish === undefined || finish.type !== 'finish' || finish.replayState === undefined) return undefined
  return (finish.replayState.response as ReplayUsagePayload).copilotUsage
}

function harness(options_?: {
  convention?: InputConventionConfig
  enabled?: boolean
  logs?: string[]
  tracker?: ConsumptionTracker
}): { runtime: MockRuntime; adapter: GitHubCopilotAdapter; tracker: ConsumptionTracker } {
  const runtime = new MockRuntime()
  const tracker =
    options_?.tracker ??
    new ConsumptionTracker({
      ...(options_?.convention === undefined ? {} : { convention: options_.convention }),
      ...(options_?.enabled === undefined ? {} : { enabled: options_.enabled }),
      logger: { info: (message) => options_?.logs?.push(message) },
    })
  return { runtime, adapter: new GitHubCopilotAdapter(runtime, tracker), tracker }
}

describe('adapter usage tracking', () => {
  it('emits real usage and replay metadata from a complete assistant.usage event', async () => {
    const { runtime, adapter } = harness()
    const call = new MockCall()
    runtime.calls.push(call)
    call.queue.push({ type: 'text-delta', id: 'm1', text: 'hi' })
    call.queue.push({
      type: 'usage',
      data: usage({
        model: 'gpt-5.4',
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 500,
        durationMs: 1200,
        timeToFirstTokenMs: 180,
        nanoAiu: 41_250_000,
        apiCallId: 'chatcmpl-abc',
        providerCallId: 'gh-request-1',
      }),
    })
    call.queue.push({ type: 'done' })
    call.queue.close()

    const chunks = await collect(adapter.stream(options()))
    const chunk = usageChunk(chunks)
    expect(chunk?.usage.inputTokens).toBe(1000)
    expect(chunk?.usage.outputTokens).toBe(100)
    expect(chunk?.usage.cacheReadTokens).toBe(500)

    const replay = replayUsage(chunks)
    expect(replay?.version).toBe(1)
    expect(replay?.usageObserved).toBe(true)
    expect(replay?.calls[0]?.providerCallId).toBe('gh-request-1')
    // Raw nano-AIU only: no credits derived from it (conversion uncalibrated).
    expect(replay?.nanoAiuTotal).toBe(41_250_000)
    expect(replay?.estimate?.source).toBe('local-estimate')
    // 1000 in @ $2.50/1M + 500 cached @ $0.25/1M + 100 out @ $15/1M = $0.004125
    expect(replay?.estimate?.totalUsd).toBeCloseTo(0.004125, 9)
    expect(replay?.estimate?.totalCredits).toBeCloseTo(0.4125, 9)
  })

  it('accepts usage arriving as the last event before done (streaming tail)', async () => {
    const { runtime, adapter } = harness()
    const call = new MockCall()
    runtime.calls.push(call)
    call.queue.push({ type: 'text-delta', id: 'm1', text: 'hello' })
    call.queue.push({ type: 'usage', data: usage({ model: 'gpt-5.4', inputTokens: 10, outputTokens: 5 }) })
    call.queue.push({ type: 'done' })
    call.queue.close()

    const chunks = await collect(adapter.stream(options()))
    const usageIndex = chunks.findIndex((chunk) => chunk.type === 'usage')
    const finishIndex = chunks.findIndex((chunk) => chunk.type === 'finish')
    expect(usageIndex).toBeGreaterThan(-1)
    expect(usageIndex).toBeLessThan(finishIndex)
  })

  it('emits no usage chunk and no replay metadata when the stream carries no usage', async () => {
    const { runtime, adapter, tracker } = harness()
    const call = new MockCall()
    runtime.calls.push(call)
    call.queue.push({ type: 'text-delta', id: 'm1', text: 'hi' })
    call.queue.push({ type: 'done' })
    call.queue.close()

    const chunks = await collect(adapter.stream(options()))
    expect(usageChunk(chunks)).toBeUndefined()
    expect(replayUsage(chunks)).toBeUndefined()
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    // Nothing was invented, and nothing was recorded either.
    expect(tracker.snapshot().responses).toBe(0)
  })

  it('reports the model actually used when it differs from the requested one (Auto mode)', async () => {
    const { runtime, adapter } = harness()
    const call = new MockCall()
    runtime.calls.push(call)
    call.queue.push({
      type: 'usage',
      data: usage({ model: 'claude-sonnet-4.5', inputTokens: 42, outputTokens: 7 }),
    })
    call.queue.push({ type: 'done' })
    call.queue.close()

    const chunks = await collect(adapter.stream(options('auto')))
    const replay = replayUsage(chunks)
    expect(replay?.requestedModel).toBe('auto')
    expect(replay?.models).toEqual([
      { model: 'claude-sonnet-4.5', calls: 1, nanoAiu: null, estimatedCredits: expect.any(Number), pricing: 'known' },
    ])
  })

  it('keeps every model listed when one response aggregates calls on different models', async () => {
    const { runtime, adapter } = harness()
    const call = new MockCall()
    runtime.calls.push(call)
    call.queue.push({ type: 'usage', data: usage({ model: 'gpt-5.4', inputTokens: 100, outputTokens: 10, nanoAiu: 100 }) })
    call.queue.push({ type: 'usage', data: usage({ model: 'claude-sonnet-4.5', inputTokens: 200, outputTokens: 20, nanoAiu: 200 }) })
    call.queue.push({ type: 'usage', data: usage({ model: 'gpt-5.4', inputTokens: 50, outputTokens: 5, nanoAiu: 50 }) })
    call.queue.push({ type: 'done' })
    call.queue.close()

    const chunks = await collect(adapter.stream(options('auto')))
    const replay = replayUsage(chunks)
    expect(replay?.models).toHaveLength(2)
    const gpt = replay?.models.find((entry) => entry.model === 'gpt-5.4')
    const claude = replay?.models.find((entry) => entry.model === 'claude-sonnet-4.5')
    expect(gpt?.calls).toBe(2)
    expect(gpt?.nanoAiu).toBe(150)
    expect(claude?.calls).toBe(1)
    // Per-model estimated cost is present for both, never collapsed.
    expect(gpt?.estimatedCredits).toBeCloseTo(0.06, 9) // 150 in @ $2.50 + 15 out @ $15 on GPT-5.4
    expect(claude?.estimatedCredits).toBeCloseTo(0.09, 9) // 200 in + 20 out on Sonnet
    expect(replay?.nanoAiuTotal).toBe(350)
  })

  it('records and logs session.model_change with its rate_limit_auto_switch cause', async () => {
    const logs: string[] = []
    const { runtime, adapter, tracker } = harness({ logs })
    const call = new MockCall()
    runtime.calls.push(call)
    call.queue.push({
      type: 'model-change',
      data: { newModel: 'claude-sonnet-4.5', previousModel: 'gpt-5.4', cause: 'rate_limit_auto_switch' },
    })
    call.queue.push({ type: 'usage', data: usage({ model: 'claude-sonnet-4.5', inputTokens: 5, outputTokens: 2 }) })
    call.queue.push({ type: 'done' })
    call.queue.close()

    const chunks = await collect(adapter.stream(options('auto')))
    expect(replayUsage(chunks)?.modelChanges).toEqual([
      { newModel: 'claude-sonnet-4.5', previousModel: 'gpt-5.4', cause: 'rate_limit_auto_switch', at: expect.any(String) },
    ])
    expect(logs.some((message) => message.includes('rate_limit_auto_switch'))).toBe(true)
    expect(tracker.snapshot().modelChanges).toHaveLength(1)
  })

  it('still reports tokens and estimate when copilotUsage (nano-AIU) is absent', async () => {
    const { runtime, adapter } = harness()
    const call = new MockCall()
    runtime.calls.push(call)
    call.queue.push({ type: 'usage', data: usage({ model: 'gpt-5.4', inputTokens: 1000, outputTokens: 100 }) })
    call.queue.push({ type: 'done' })
    call.queue.close()

    const chunks = await collect(adapter.stream(options()))
    expect(usageChunk(chunks)?.usage).toMatchObject({ inputTokens: 1000, outputTokens: 100 })
    const replay = replayUsage(chunks)
    expect(replay?.nanoAiuTotal).toBeNull()
    expect(replay?.estimate?.source).toBe('local-estimate')
  })

  it('never invents a price for a model missing from the pricing table', async () => {
    const { runtime, adapter, tracker } = harness()
    const call = new MockCall()
    runtime.calls.push(call)
    call.queue.push({ type: 'usage', data: usage({ model: 'some-future-model', inputTokens: 10, outputTokens: 5 }) })
    call.queue.push({ type: 'done' })
    call.queue.close()

    const chunks = await collect(adapter.stream(options()))
    // Tokens are still reported; only the price is withheld.
    expect(usageChunk(chunks)?.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 })
    const replay = replayUsage(chunks)
    expect(replay?.estimate?.unknownModels).toEqual(['some-future-model'])
    expect(replay?.estimate?.perModel).toEqual([])
    expect(replay?.estimate?.totalCredits).toBe(0)
    expect(replay?.models[0]?.estimatedCredits).toBeNull()
    expect(replay?.models[0]?.pricing).toBe('unknown')
    expect(tracker.snapshot().unknownModels).toEqual(['some-future-model'])
  })

  it('detects the disjoint token convention by observation and logs it once', async () => {
    const logs: string[] = []
    const { runtime, adapter, tracker } = harness({ logs })
    // inputTokens < cacheReadTokens is impossible when input includes cache reads.
    for (let index = 0; index < 2; index += 1) {
      const call = new MockCall()
      runtime.calls.push(call)
      call.queue.push({
        type: 'usage',
        data: usage({ model: 'gpt-5.4', inputTokens: 20, cacheReadTokens: 900, outputTokens: 5 }),
      })
      call.queue.push({ type: 'done' })
      call.queue.close()
      const chunks = await collect(adapter.stream(options()))
      expect(usageChunk(chunks)?.usage).toMatchObject({ inputTokens: 20, cacheReadTokens: 900 })
    }
    expect(tracker.convention()).toBe('disjoint')
    expect(logs.filter((message) => message.includes('disjoint'))).toHaveLength(1)
  })

  it('prefers not to subtract cache reads when the convention is ambiguous', async () => {
    const { runtime, adapter, tracker } = harness()
    const call = new MockCall()
    runtime.calls.push(call)
    // inputTokens > cacheReadTokens: consistent with both conventions, so no proof.
    call.queue.push({
      type: 'usage',
      data: usage({ model: 'gpt-5.4', inputTokens: 1000, cacheReadTokens: 500, outputTokens: 5 }),
    })
    call.queue.push({ type: 'done' })
    call.queue.close()

    const chunks = await collect(adapter.stream(options()))
    expect(tracker.convention()).toBe('unsubtracted-ambiguous')
    // Not subtracted: 1000, not 500 (documented over-reporting bias if inclusive).
    expect(usageChunk(chunks)?.usage).toMatchObject({ inputTokens: 1000, cacheReadTokens: 500 })
  })

  it('applies a configured inclusive convention by subtracting cache reads', async () => {
    const { runtime, adapter, tracker } = harness({ convention: 'inclusive' })
    const call = new MockCall()
    runtime.calls.push(call)
    call.queue.push({
      type: 'usage',
      data: usage({ model: 'gpt-5.4', inputTokens: 1000, cacheReadTokens: 500, outputTokens: 5 }),
    })
    call.queue.push({ type: 'done' })
    call.queue.close()

    const chunks = await collect(adapter.stream(options()))
    expect(tracker.convention()).toBe('inclusive')
    expect(tracker.snapshot().conventionSource).toBe('configured')
    expect(usageChunk(chunks)?.usage).toMatchObject({ inputTokens: 500, cacheReadTokens: 500 })
  })

  it('records partial usage when the stream is interrupted before the terminal event', async () => {
    const { runtime, adapter, tracker } = harness()
    const call = new MockCall()
    runtime.calls.push(call)
    call.queue.push({ type: 'text-delta', id: 'm1', text: 'partial' })
    call.queue.push({ type: 'usage', data: usage({ model: 'gpt-5.4', inputTokens: 64, outputTokens: 8 }) })
    call.queue.close() // stream ends without 'done'

    await expect(collect(adapter.stream(options()))).rejects.toThrow()
    const snapshot = tracker.snapshot()
    expect(snapshot.responses).toBe(1)
    expect(snapshot.perModel[0]).toMatchObject({ model: 'gpt-5.4', inputTokens: 64, outputTokens: 8 })
  })

  it('isolates tracking failures: a throwing tracker never breaks the response', async () => {
    const runtime = new MockRuntime()
    const tracker = new ConsumptionTracker()
    const call = new MockCall()
    runtime.calls.push(call)
    call.queue.push({ type: 'usage', data: usage({ model: 'gpt-5.4', inputTokens: 1, outputTokens: 1 }) })
    call.queue.push({ type: 'done' })
    call.queue.close()

    tracker.summarize = () => {
      throw new Error('synthetic tracking failure')
    }
    const adapter = new GitHubCopilotAdapter(runtime, tracker)
    const chunks = await collect(adapter.stream(options()))

    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(usageChunk(chunks)).toBeUndefined()
    expect(tracker.snapshot().isolationErrors).toBe(1)
    expect(tracker.snapshot().lastError).toContain('synthetic tracking failure')
  })

  it('does not track anything when usageTracking is disabled', async () => {
    const { runtime, adapter, tracker } = harness({ enabled: false })
    const call = new MockCall()
    runtime.calls.push(call)
    call.queue.push({ type: 'usage', data: usage({ model: 'gpt-5.4', inputTokens: 1, outputTokens: 1 }) })
    call.queue.push({ type: 'done' })
    call.queue.close()

    const chunks = await collect(adapter.stream(options()))
    expect(usageChunk(chunks)).toBeUndefined()
    expect(replayUsage(chunks)).toBeUndefined()
    expect(tracker.snapshot().enabled).toBe(false)
    expect(tracker.snapshot().responses).toBe(0)
  })
})
