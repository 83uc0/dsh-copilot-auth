import { createToolResultMessage, createUserMessage, type GenerateOptions, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
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
} from '../src/copilot-runtime.js'

const MODEL: RuntimeModel = {
  id: 'gpt-test',
  name: 'GPT Test',
  enabled: true,
  contextWindow: 128_000,
  vision: false,
  reasoningEfforts: ['low', 'high'],
  defaultReasoningEffort: 'low',
}

class MockCall implements ActiveRuntimeCall {
  readonly queue = new AsyncQueue<RuntimeEvent>()
  readonly responses: Array<{ requestId: string; result: string; isError: boolean }> = []
  aborted = false
  disposed = false

  get events(): AsyncIterable<RuntimeEvent> {
    return this.queue
  }

  async respondToTool(requestId: string, result: string, isError: boolean): Promise<void> {
    this.responses.push({ requestId, result, isError })
  }

  async abort(): Promise<void> {
    this.aborted = true
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.queue.close()
  }
}

class MockRuntime implements CopilotRuntime {
  readonly requests: RuntimeCallRequest[] = []
  readonly calls: MockCall[] = []
  stopped = false

  async start(): Promise<void> {}
  async stop(): Promise<void> { this.stopped = true }
  async getAuthStatus(): Promise<RuntimeAuthStatus> { return { isAuthenticated: true, login: 'octocat' } }
  async listModels(): Promise<readonly RuntimeModel[]> { return [MODEL, { ...MODEL, id: 'disabled', enabled: false }] }
  async startCall(request: RuntimeCallRequest): Promise<ActiveRuntimeCall> {
    this.requests.push(request)
    const call = this.calls.shift()
    if (call === undefined) throw new Error('No mock call queued')
    return call
  }
}

function options(messages: Message[] = [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })]): GenerateOptions {
  return {
    provider: 'github-copilot-sdk',
    model: 'gpt-test',
    messages,
    tools: [{ name: 'weather', description: 'Get weather', parameters: { type: 'object' } }],
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('GitHubCopilotAdapter', () => {
  it('advertises only enabled account-authorized models and rejects arbitrary ids', async () => {
    const runtime = new MockRuntime()
    const adapter = new GitHubCopilotAdapter(runtime)
    expect((await adapter.listModels('github-copilot-sdk')).map((model) => model.id)).toEqual(['gpt-test'])
    await expect(adapter.resolveModel('github-copilot-sdk', 'disabled')).rejects.toMatchObject({ code: 'MODEL_NOT_AUTHORIZED' })
    await expect(adapter.resolveModel('github-copilot-sdk', 'invented')).rejects.toMatchObject({ code: 'MODEL_NOT_AUTHORIZED' })
  })

  it('maps text and reasoning streaming events to DSH blocks', async () => {
    const runtime = new MockRuntime()
    const call = new MockCall()
    runtime.calls.push(call)
    call.queue.push({ type: 'reasoning-delta', id: 'msg-1', text: 'think' })
    call.queue.push({ type: 'text-delta', id: 'msg-2', text: 'hello' })
    call.queue.push({ type: 'text-delta', id: 'msg-2', text: ' world' })
    call.queue.push({ type: 'done' })
    call.queue.close()

    const chunks = await collect(new GitHubCopilotAdapter(runtime).stream(options()))
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'think' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 1, text: 'hello' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(call.disposed).toBe(true)
  })

  it('starts a fresh block instead of concatenating text once the SDK restarts a message (e.g. an internal retry)', async () => {
    const runtime = new MockRuntime()
    const call = new MockCall()
    runtime.calls.push(call)
    call.queue.push({ type: 'text-delta', id: 'attempt-1', text: 'Cop' })
    call.queue.push({ type: 'text-delta', id: 'attempt-2', text: 'Copilot is working..' })
    call.queue.push({ type: 'done' })
    call.queue.close()

    const chunks = await collect(new GitHubCopilotAdapter(runtime).stream(options()))
    const textDeltas = chunks.filter((chunk) => chunk.type === 'text-delta')
    const textEnds = chunks.filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text')

    expect(textDeltas).toEqual([
      { type: 'text-delta', index: 0, text: 'Cop' },
      { type: 'text-delta', index: 1, text: 'Copilot is working..' },
    ])
    expect(textEnds).toEqual([
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Cop' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Copilot is working..' } },
    ])
  })

  it('keeps the official SDK call alive across a DSH tool call and result', async () => {
    const runtime = new MockRuntime()
    const call = new MockCall()
    runtime.calls.push(call)
    call.queue.push({
      type: 'tool-request',
      requestId: 'request-1',
      toolCallId: 'call-1',
      name: 'weather',
      arguments: { city: 'Paris' },
    })

    const adapter = new GitHubCopilotAdapter(runtime)
    const first = await collect(adapter.stream(options()))
    expect(first.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(call.disposed).toBe(false)

    call.queue.push({ type: 'text-delta', id: 'msg-1', text: 'Sunny' })
    call.queue.push({ type: 'done' })
    call.queue.close()
    const resultMessage = createToolResultMessage({
      callId: 'call-1' as never,
      content: [{ type: 'text', text: '23 C' }],
      isError: false,
    })
    const second = await collect(adapter.stream(options([resultMessage])))

    expect(runtime.requests).toHaveLength(1)
    expect(call.responses).toEqual([{ requestId: 'request-1', result: '23 C', isError: false }])
    expect(second).toContainEqual({ type: 'text-delta', index: 0, text: 'Sunny' })
    expect(second.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('drops the pending tool entry before awaiting the SDK response, so a concurrent duplicate cannot resubmit it', async () => {
    const runtime = new MockRuntime()
    const call = new MockCall()
    runtime.calls.push(call)
    call.queue.push({
      type: 'tool-request',
      requestId: 'request-1',
      toolCallId: 'call-1',
      name: 'weather',
      arguments: { city: 'Paris' },
    })
    const adapter = new GitHubCopilotAdapter(runtime)
    await collect(adapter.stream(options()))

    let releaseRespond: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      releaseRespond = resolve
    })
    let markReached: () => void = () => {}
    const reached = new Promise<void>((resolve) => {
      markReached = resolve
    })
    const seenRequestIds: string[] = []
    call.respondToTool = async (requestId) => {
      seenRequestIds.push(requestId)
      markReached()
      await released
    }

    const resultMessage = createToolResultMessage({
      callId: 'call-1' as never,
      content: [{ type: 'text', text: '23 C' }],
      isError: false,
    })
    const secondCall = new MockCall()
    secondCall.queue.push({ type: 'done' })
    secondCall.queue.close()
    runtime.calls.push(secondCall)

    const firstStream = collect(adapter.stream(options([resultMessage])))
    await reached // the first continuation is now suspended inside respondToTool

    const secondStream = collect(adapter.stream(options([resultMessage])))
    releaseRespond()
    call.queue.push({ type: 'done' })
    call.queue.close()

    await Promise.all([firstStream, secondStream])

    expect(seenRequestIds).toEqual(['request-1'])
    expect(runtime.requests).toHaveLength(2)
  })

  it('aborts and disposes retained calls when the plugin unloads', async () => {
    const runtime = new MockRuntime()
    const call = new MockCall()
    runtime.calls.push(call)
    call.queue.push({ type: 'tool-request', requestId: 'r', toolCallId: 'c', name: 'weather', arguments: {} })
    const adapter = new GitHubCopilotAdapter(runtime)
    await collect(adapter.stream(options()))
    await adapter.dispose()
    expect(call.aborted).toBe(true)
    expect(call.disposed).toBe(true)
    expect(runtime.stopped).toBe(true)
  })
})
