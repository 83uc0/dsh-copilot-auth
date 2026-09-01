import {
  LlmAdapter,
  LlmError,
  type CallId,
  type ContentBlock,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type Message,
  type ReasoningEffortId,
  type ReplayEnvelope,
  type StreamChunk,
  type ToolResultBlock,
} from '@deepseek-ai/dsh-llm'
import type {
  ActiveRuntimeCall,
  CopilotRuntime,
  RuntimeModel,
} from './copilot-runtime.js'
import { classifyCopilotError } from './errors.js'
import { toReplayUsage, type ConsumptionTracker, type ResponseUsageSummary } from './usage-tracker.js'

export const PROVIDER = 'github-copilot-sdk'

interface PendingTool {
  readonly call: ActiveRuntimeCall
  readonly requestId: string
  readonly callId: CallId
}

interface OpenBlock {
  readonly index: number
  readonly type: 'text' | 'reasoning'
  readonly id: string
  text: string
}

function stringifyBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'reasoning':
      return block.text
    case 'image':
      return '[image omitted: the official Copilot SDK adapter currently accepts text input only]'
    case 'tool-call':
      return `Tool call ${block.name} (${block.id}): ${block.arguments}`
    case 'tool-result':
      return block.content.map(stringifyBlock).join('\n')
    default:
      return '[unsupported content block]'
  }
}

export function serializeConversation(messages: readonly Message[]): string {
  return messages
    .map((message) => {
      const content = message.content.map(stringifyBlock).join('\n')
      return `<dsh-message role="${message.role}">\n${content}\n</dsh-message>`
    })
    .join('\n\n')
}

function pendingResult(messages: readonly Message[], callId: CallId): ToolResultBlock | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (message === undefined) continue
    for (const block of message.content) {
      if (block.type === 'tool-result' && block.toolCallId === callId) return block
    }
  }
  return undefined
}

function toolResultText(result: ToolResultBlock): string {
  const text = result.content.map(stringifyBlock).join('\n')
  return text.length > 0 ? text : '(tool returned no textual content)'
}

function modelInfo(model: RuntimeModel): LlmResolvedModelInfo {
  return {
    provider: PROVIDER,
    id: model.id,
    name: model.name,
    inputModalities: ['text'],
    ...(model.contextWindow > 0 ? { context: { contextWindow: model.contextWindow } } : {}),
    ...(model.reasoningEfforts.length === 0
      ? {}
      : {
          reasoning: {
            efforts: model.reasoningEfforts.map((effort) => ({
              id: effort as ReasoningEffortId,
              name: effort,
            })),
            ...(model.defaultReasoningEffort === undefined
              ? {}
              : { defaultEffort: model.defaultReasoningEffort as ReasoningEffortId }),
          },
        }),
  }
}

export class GitHubCopilotAdapter extends LlmAdapter {
  readonly #pending = new Map<CallId, PendingTool>()
  readonly #active = new Set<ActiveRuntimeCall>()

  constructor(
    private readonly runtime: CopilotRuntime,
    private readonly tracker?: ConsumptionTracker,
  ) {
    super()
  }

  override providerInfo(provider: string): { id: string; name: string } {
    if (provider !== PROVIDER) throw new LlmError(`Unsupported provider route: ${provider}`, 'NO_ADAPTER')
    return { id: PROVIDER, name: 'GitHub Copilot' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.providerInfo(provider)
    try {
      return (await this.runtime.listModels()).filter((model) => model.enabled).map(modelInfo)
    } catch (error) {
      throw classifyCopilotError(error)
    }
  }

  override async resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
    this.providerInfo(provider)
    let models: readonly RuntimeModel[]
    try {
      models = await this.runtime.listModels()
    } catch (error) {
      throw classifyCopilotError(error)
    }
    const model = models.find((candidate) => candidate.enabled && candidate.id === id)
    if (model === undefined) {
      throw new LlmError(`GitHub Copilot model "${id}" is not authorized for the current account`, 'MODEL_NOT_AUTHORIZED', {
        status: 403,
      })
    }
    return modelInfo(model)
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.provider !== PROVIDER) throw new LlmError(`Unsupported provider route: ${options.provider}`, 'NO_ADAPTER')
    await this.resolveModel(options.provider, options.model)

    const continuation = this.#findContinuation(options.messages)
    let call: ActiveRuntimeCall
    if (continuation === undefined) {
      try {
        call = await this.runtime.startCall({
          model: options.model,
          ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
          ...(options.system === undefined ? {} : { system: options.system }),
          prompt: serializeConversation(options.messages),
          tools: (options.tools ?? []).map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        })
        this.#active.add(call)
      } catch (error) {
        throw classifyCopilotError(error)
      }
    } else {
      call = continuation.pending.call
      // Remove before awaiting: a concurrent continuation for the same callId must not resubmit this requestId.
      this.#pending.delete(continuation.pending.callId)
      try {
        await call.respondToTool(
          continuation.pending.requestId,
          toolResultText(continuation.result),
          continuation.result.isError === true,
        )
      } catch (error) {
        await this.#retire(call)
        throw classifyCopilotError(error)
      }
    }

    const abort = (): void => {
      void call.abort()
    }
    options.signal?.addEventListener('abort', abort, { once: true })

    let nextIndex = 0
    const open = new Map<'text' | 'reasoning', OpenBlock>()
    const collector = this.tracker?.enabled === true ? this.tracker.startResponse() : undefined
    let trackingFinalized = false
    /**
     * Summarize and record the response's usage, then derive the stream
     * additions. Tracking must never break a response: any failure is counted
     * in the tracker's isolation counter and the stream continues without the
     * usage chunk. Idempotent so error paths can flush a partial observation.
     */
    const finalizeTracking = ():
      | { readonly summary: ResponseUsageSummary; readonly usageChunk: StreamChunk | undefined }
      | undefined => {
      const tracker = this.tracker
      if (tracker === undefined || collector === undefined || trackingFinalized) return undefined
      trackingFinalized = true
      if (!collector.hasData) return undefined
      try {
        const summary = tracker.summarize(collector, options.model)
        tracker.recordResponse(summary)
        const usageChunk: StreamChunk | undefined =
          summary.usageObserved && summary.tokens !== undefined
            ? { type: 'usage', usage: summary.tokens }
            : undefined
        return { summary, usageChunk }
      } catch (error) {
        tracker.recordError('summarize response usage', error)
        return undefined
      }
    }
    try {
      for await (const event of call.events) {
        if (options.signal?.aborted === true) throw options.signal.reason
        if (event.type === 'usage') {
          collector?.addCall(event.data)
          continue
        }
        if (event.type === 'model-change') {
          collector?.addModelChange(event.data)
          continue
        }
        if (event.type === 'text-delta' || event.type === 'reasoning-delta') {
          const type = event.type === 'text-delta' ? 'text' : 'reasoning'
          const stale = open.get(type)
          if (stale !== undefined && stale.id !== event.id) {
            // The SDK started a new message (e.g. an internal retry); stop appending onto the abandoned one.
            yield closeBlockChunk(stale)
            open.delete(type)
          }
          let block = open.get(type)
          if (block === undefined) {
            block = { index: nextIndex, type, id: event.id, text: '' }
            nextIndex += 1
            open.set(type, block)
            yield { type: 'block-start', index: block.index, blockType: type }
          }
          block.text += event.text
          yield event.type === 'text-delta'
            ? { type: 'text-delta', index: block.index, text: event.text }
            : { type: 'reasoning-delta', index: block.index, text: event.text }
          continue
        }
        if (event.type === 'tool-request') {
          yield* closeOpenBlocks(open)
          const index = nextIndex
          const callId = event.toolCallId as CallId
          const argumentsText = JSON.stringify(event.arguments)
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id: callId, name: event.name, argumentsDelta: argumentsText }
          yield {
            type: 'block-end',
            index,
            block: { type: 'tool-call', id: callId, name: event.name, arguments: argumentsText },
          }
          this.#pending.set(callId, { call, requestId: event.requestId, callId })
          const toolFinishTracking = finalizeTracking()
          if (toolFinishTracking?.usageChunk !== undefined) yield toolFinishTracking.usageChunk
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        if (event.type === 'error') throw event.error
        if (event.type === 'done') {
          yield* closeOpenBlocks(open)
          const tracking = finalizeTracking()
          if (tracking?.usageChunk !== undefined) yield tracking.usageChunk
          // replayState is reserved for successful responses; tool-call and
          // error finishes only carry the usage chunk.
          const replayState: ReplayEnvelope | undefined =
            tracking === undefined ? undefined : { response: toReplayUsage(tracking.summary) }
          yield {
            type: 'finish',
            reason: { kind: 'stop' },
            ...(replayState === undefined ? {} : { replayState }),
          }
          await this.#retire(call)
          return
        }
      }
      throw new Error('GitHub Copilot stream closed before a terminal event')
    } catch (error) {
      // Flush a partial observation so an interrupted stream is still counted.
      finalizeTracking()
      await this.#retire(call)
      throw classifyCopilotError(error)
    } finally {
      options.signal?.removeEventListener('abort', abort)
    }
  }

  async dispose(): Promise<void> {
    const active = [...this.#active]
    this.#pending.clear()
    await Promise.allSettled(active.map((call) => call.abort()))
    await Promise.allSettled(active.map((call) => call.dispose()))
    this.#active.clear()
    await this.runtime.stop()
  }

  #findContinuation(messages: readonly Message[]): { pending: PendingTool; result: ToolResultBlock } | undefined {
    for (const pending of this.#pending.values()) {
      const result = pendingResult(messages, pending.callId)
      if (result !== undefined) return { pending, result }
    }
    return undefined
  }

  async #retire(call: ActiveRuntimeCall): Promise<void> {
    this.#active.delete(call)
    for (const [callId, pending] of this.#pending) {
      if (pending.call === call) this.#pending.delete(callId)
    }
    await call.dispose()
  }
}

function closeBlockChunk(block: OpenBlock): StreamChunk {
  return {
    type: 'block-end',
    index: block.index,
    block: block.type === 'text' ? { type: 'text', text: block.text } : { type: 'reasoning', text: block.text },
  }
}

function* closeOpenBlocks(open: Map<'text' | 'reasoning', OpenBlock>): Iterable<StreamChunk> {
  for (const block of [...open.values()].sort((left, right) => left.index - right.index)) {
    yield closeBlockChunk(block)
  }
  open.clear()
}
