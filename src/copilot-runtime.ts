import { spawn } from 'node:child_process'
import { accessSync, constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  CopilotClient,
  RuntimeConnection,
  type CopilotSession,
  type ErrorData,
  type ModelInfo,
  type SessionEvent,
  type SessionEventPayload,
  type Tool,
} from '@github/copilot-sdk'
import { AsyncQueue } from './async-queue.js'
import { safeErrorMessage } from './redaction.js'

export interface RuntimeAuthStatus {
  readonly isAuthenticated: boolean
  readonly authType?: string
  readonly host?: string
  readonly login?: string
  readonly statusMessage?: string
}

export interface RuntimeModel {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly contextWindow: number
  readonly vision: boolean
  readonly reasoningEfforts: readonly string[]
  readonly defaultReasoningEffort?: string
}

export interface RuntimeTool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
}

export interface RuntimeCallRequest {
  readonly model: string
  readonly reasoningEffort?: string
  readonly system?: string
  readonly prompt: string
  readonly tools: readonly RuntimeTool[]
}

/**
 * Usage metrics of one model API call, flattened from the SDK's
 * `assistant.usage` event. Every field except `model` is optional: the SDK
 * documents the event as not stable across all Copilot models, so consumers
 * must treat absence as "not reported", never as zero.
 */
export interface RuntimeUsageData {
  /** Model identifier actually used for this call (resolves Auto mode). */
  readonly model: string
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
  readonly durationMs?: number
  readonly timeToFirstTokenMs?: number
  readonly interTokenLatencyMs?: number
  /** Raw per-request cost from CAPI `copilot_usage`; the nano→credit conversion is calibrated elsewhere. */
  readonly nanoAiu?: number
  readonly apiCallId?: string
  readonly providerCallId?: string
  readonly serviceRequestId?: string
  readonly finishReason?: string
}

/** Model switch during a session, from the SDK's `session.model_change` event. */
export interface RuntimeModelChangeData {
  readonly newModel: string
  readonly previousModel?: string
  /** e.g. "rate_limit_auto_switch" for Auto-mode recovery switches. */
  readonly cause?: string
}

export type RuntimeEvent =
  | { readonly type: 'text-delta'; readonly id: string; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly id: string; readonly text: string }
  | {
      readonly type: 'tool-request'
      readonly requestId: string
      readonly toolCallId: string
      readonly name: string
      readonly arguments: Record<string, unknown>
    }
  | { readonly type: 'usage'; readonly data: RuntimeUsageData }
  | { readonly type: 'model-change'; readonly data: RuntimeModelChangeData }
  | { readonly type: 'done' }
  | { readonly type: 'error'; readonly error: Error }

export interface ActiveRuntimeCall {
  readonly events: AsyncIterable<RuntimeEvent>
  respondToTool(requestId: string, result: string, isError: boolean): Promise<void>
  abort(): Promise<void>
  dispose(): Promise<void>
}

export interface CopilotRuntime {
  start(): Promise<void>
  stop(): Promise<void>
  getAuthStatus(): Promise<RuntimeAuthStatus>
  listModels(): Promise<readonly RuntimeModel[]>
  startCall(request: RuntimeCallRequest): Promise<ActiveRuntimeCall>
}

export interface CopilotTransport {
  readonly mode: 'direct' | 'edgee'
  readonly proxyUrl?: string
  readonly caPath?: string
}

export interface CopilotRuntimeFactory {
  create(transport: CopilotTransport): CopilotRuntime
}

export interface LoginRunner {
  login(signal: AbortSignal): Promise<void>
  logout(signal: AbortSignal): Promise<void>
}

function childEnvironment(transport: CopilotTransport = { mode: 'direct' }): NodeJS.ProcessEnv {
  const allowed = [
    'HOME',
    'PATH',
    'LANG',
    'LC_ALL',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_RUNTIME_DIR',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'DBUS_SESSION_BUS_ADDRESS',
  ] as const
  return Object.fromEntries([
    ...allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]),
    ...(transport.mode === 'edgee' && transport.proxyUrl !== undefined ? [['HTTPS_PROXY', transport.proxyUrl], ['https_proxy', transport.proxyUrl]] : []),
    ...(transport.mode === 'edgee' && transport.caPath !== undefined ? [['NODE_EXTRA_CA_CERTS', transport.caPath]] : []),
  ])
}

export class CopilotCliLoginRunner implements LoginRunner {
  constructor(private readonly executable = 'copilot') {}

  login(signal: AbortSignal): Promise<void> {
    return this.#run(['login', '--web-flow'], 'login', signal)
  }

  logout(signal: AbortSignal): Promise<void> {
    return this.#run([
      '--prompt',
      '/logout',
      '--silent',
      '--no-custom-instructions',
      '--disable-builtin-mcps',
      '--no-remote',
      '--no-remote-export',
      '--log-level',
      'none',
    ], 'logout', signal)
  }

  #run(arguments_: readonly string[], operation: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [...arguments_], {
        env: childEnvironment(),
        stdio: ['ignore', 'ignore', 'pipe'],
        signal,
      })
      let diagnostic = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        diagnostic = `${diagnostic}${chunk}`.slice(-4096)
      })
      child.once('error', reject)
      child.once('exit', (code, exitSignal) => {
        if (code === 0) resolve()
        else reject(new Error(`copilot ${operation} failed (${exitSignal ?? `exit ${String(code)}`}): ${safeErrorMessage(diagnostic)}`))
      })
    })
  }
}

class OfficialActiveCall implements ActiveRuntimeCall {
  readonly #queue = new AsyncQueue<RuntimeEvent>()
  readonly #unsubscribe: () => void
  #disposed = false

  constructor(private readonly session: CopilotSession) {
    this.#unsubscribe = session.on((event) => this.#accept(event))
  }

  get events(): AsyncIterable<RuntimeEvent> {
    return this.#queue
  }

  async send(prompt: string): Promise<void> {
    try {
      await this.session.send({ prompt })
    } catch (error) {
      this.#queue.push({ type: 'error', error: error instanceof Error ? error : new Error(safeErrorMessage(error)) })
      this.#queue.close()
    }
  }

  async respondToTool(requestId: string, result: string, isError: boolean): Promise<void> {
    const response = isError
      ? await this.session.rpc.tools.handlePendingToolCall({ requestId, error: result })
      : await this.session.rpc.tools.handlePendingToolCall({ requestId, result })
    // The RPC result carries no reason field; requestId is the only diagnostic the SDK gives us.
    if (!response.success) throw new Error(`GitHub Copilot rejected the pending tool result for request ${requestId}`)
  }

  async abort(): Promise<void> {
    await this.session.abort()
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#unsubscribe()
    this.#queue.close()
    await this.session.disconnect()
  }

  #accept(event: SessionEvent): void {
    switch (event.type) {
      case 'assistant.message_delta':
        if (event.data.deltaContent.length > 0) {
          this.#queue.push({ type: 'text-delta', id: event.data.messageId, text: event.data.deltaContent })
        }
        return
      case 'assistant.reasoning_delta':
        if (event.data.deltaContent.length > 0) {
          this.#queue.push({ type: 'reasoning-delta', id: event.data.reasoningId, text: event.data.deltaContent })
        }
        return
      case 'external_tool.requested':
        this.#queue.push({
          type: 'tool-request',
          requestId: event.data.requestId,
          toolCallId: event.data.toolCallId,
          name: event.data.toolName,
          arguments: event.data.arguments ?? {},
        })
        return
      case 'assistant.usage':
        this.#queue.push({ type: 'usage', data: toRuntimeUsage(event.data) })
        return
      case 'session.model_change':
        this.#queue.push({
          type: 'model-change',
          data: {
            newModel: event.data.newModel,
            ...(event.data.previousModel === undefined ? {} : { previousModel: event.data.previousModel }),
            ...(event.data.cause === undefined ? {} : { cause: event.data.cause }),
          },
        })
        return
      case 'session.idle':
        this.#queue.push({ type: 'done' })
        this.#queue.close()
        return
      case 'session.error':
        this.#queue.push({ type: 'error', error: toSessionError(event.data) })
        this.#queue.close()
        return
      default:
        return
    }
  }
}

/**
 * `event.data` on `session.error` is a structured payload, not an `Error` or a
 * string, so `safeErrorMessage` alone would collapse it to "Unknown GitHub
 * Copilot error". Extract the real message plus classification hints so
 * `classifyCopilotError`'s status/keyword matching still applies downstream.
 */
/**
 * Extract the leaf fields of an `assistant.usage` event into an owned, plain
 * data object. The SDK payload is a live RPC object: only primitives cross
 * here, and absent fields stay absent (absence is meaningful — see
 * RuntimeUsageData).
 */
export function toRuntimeUsage(data: SessionEventPayload<'assistant.usage'>['data']): RuntimeUsageData {
  return {
    model: data.model,
    ...(data.inputTokens === undefined ? {} : { inputTokens: data.inputTokens }),
    ...(data.outputTokens === undefined ? {} : { outputTokens: data.outputTokens }),
    ...(data.cacheReadTokens === undefined ? {} : { cacheReadTokens: data.cacheReadTokens }),
    ...(data.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: data.cacheWriteTokens }),
    ...(data.reasoningTokens === undefined ? {} : { reasoningTokens: data.reasoningTokens }),
    ...(data.duration === undefined ? {} : { durationMs: data.duration }),
    ...(data.timeToFirstTokenMs === undefined ? {} : { timeToFirstTokenMs: data.timeToFirstTokenMs }),
    ...(data.interTokenLatencyMs === undefined ? {} : { interTokenLatencyMs: data.interTokenLatencyMs }),
    ...(data.copilotUsage === undefined ? {} : { nanoAiu: data.copilotUsage.totalNanoAiu }),
    ...(data.apiCallId === undefined ? {} : { apiCallId: data.apiCallId }),
    ...(data.providerCallId === undefined ? {} : { providerCallId: data.providerCallId }),
    ...(data.serviceRequestId === undefined ? {} : { serviceRequestId: data.serviceRequestId }),
    ...(data.finishReason === undefined ? {} : { finishReason: data.finishReason }),
  }
}

export function toSessionError(data: ErrorData): Error {
  const detail = [data.errorType, data.statusCode, data.errorCode]
    .filter((part) => part !== undefined)
    .join(' ')
  const message = safeErrorMessage(data.message)
  return new Error(detail.length > 0 ? `${message} (${detail})` : message)
}

export function toRuntimeModel(model: ModelInfo): RuntimeModel {
  const isSyntheticAuto = model.id === 'auto' || model.name === 'Auto'
  return {
    id: model.id,
    name: model.name,
    enabled: isSyntheticAuto || model.policy?.state !== 'disabled',
    contextWindow: model.capabilities.limits.max_context_window_tokens,
    vision: model.capabilities.supports.vision,
    reasoningEfforts: model.supportedReasoningEfforts ?? [],
    ...(model.defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort: model.defaultReasoningEffort }),
  }
}

/**
 * DSH tool names are not screened against the SDK's built-in tool names (e.g.
 * `bash`), so a same-named DSH tool would otherwise make session creation fail
 * with "conflicts with a built-in tool of the same name". `mode: 'empty'`
 * already disables every built-in, so DSH's declaration is always the one that
 * should win.
 */
export function toSdkTools(tools: readonly RuntimeTool[]): Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    skipPermission: true,
    defer: 'never',
    overridesBuiltInTool: true,
  }))
}

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The SDK resolves a bare command via `existsSync`, which never searches `PATH`,
 * so a `path: 'copilot'` connection option fails even when `copilot` is
 * installed. Search `PATH` ourselves and return `undefined` when unresolved so
 * the caller can omit `path` and let the SDK fall back to `COPILOT_CLI_PATH` or
 * its bundled `@github/copilot` runtime instead of failing outright.
 */
export function resolveCliPath(executable: string, env: NodeJS.ProcessEnv): string | undefined {
  if (executable.includes('/') || executable.includes('\\')) return executable
  const directories = (env.PATH ?? '').split(delimiter).filter((directory) => directory !== '')
  const suffixes = process.platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : ['']
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = join(directory, `${executable}${suffix}`)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Caches an in-flight async call so concurrent callers share one attempt instead of each
 * triggering their own — e.g. `CopilotClient.start()` only guards an already-"connected"
 * state, so two overlapping `start()` calls would otherwise both run and double-register
 * the SDK's event dispatch, delivering every session event (and so every text-delta)
 * twice. Clears the cache on rejection so a later call retries.
 */
export function memoizeAsync(factory: () => Promise<void>): { run: () => Promise<void>; reset: () => boolean } {
  let cached: Promise<void> | undefined
  return {
    run: () => {
      cached ??= factory().catch((error: unknown) => {
        cached = undefined
        throw error
      })
      return cached
    },
    reset: () => {
      const hadValue = cached !== undefined
      cached = undefined
      return hadValue
    },
  }
}

export class OfficialCopilotRuntime implements CopilotRuntime {
  readonly #client: CopilotClient
  readonly #connection: ReturnType<typeof memoizeAsync>

  constructor(
    workingDirectory: string,
    executable = 'copilot',
    baseDirectory = process.env.COPILOT_HOME ?? join(homedir(), '.copilot'),
    transport: CopilotTransport = { mode: 'direct' },
  ) {
    const env = childEnvironment(transport)
    const resolvedPath = resolveCliPath(executable, env)
    this.#client = new CopilotClient({
      connection: resolvedPath === undefined ? RuntimeConnection.forStdio() : RuntimeConnection.forStdio({ path: resolvedPath }),
      mode: 'copilot-cli',
      workingDirectory,
      baseDirectory,
      env,
      useLoggedInUser: true,
      logLevel: 'error',
    })
    this.#connection = memoizeAsync(() => this.#client.start())
  }

  async start(): Promise<void> {
    await this.#connection.run()
  }

  async stop(): Promise<void> {
    if (!this.#connection.reset()) return
    await this.#client.stop()
  }

  async getAuthStatus(): Promise<RuntimeAuthStatus> {
    await this.start()
    return this.#client.getAuthStatus()
  }

  async listModels(): Promise<readonly RuntimeModel[]> {
    await this.start()
    const rawModels = await this.#client.listModels()
    return rawModels.map(toRuntimeModel).filter((model) => model.enabled)
  }

  async startCall(request: RuntimeCallRequest): Promise<ActiveRuntimeCall> {
    await this.start()
    const tools = toSdkTools(request.tools)
    const session = await this.#client.createSession({
      clientName: 'deepseek-harness/0.1.1-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)',
      model: request.model,
      ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh' }),
      ...(request.system === undefined ? {} : { systemMessage: { mode: 'append', content: request.system } }),
      streaming: true,
      tools,
      availableTools: tools.map((tool) => tool.name),
      enableConfigDiscovery: false,
    })
    const call = new OfficialActiveCall(session)
    void call.send(request.prompt)
    return call
  }
}

class ManagedActiveCall implements ActiveRuntimeCall {
  #disposed = false

  constructor(
    private readonly call: ActiveRuntimeCall,
    private readonly release: () => Promise<void>,
  ) {}

  get events(): AsyncIterable<RuntimeEvent> { return this.call.events }

  respondToTool(requestId: string, result: string, isError: boolean): Promise<void> {
    return this.call.respondToTool(requestId, result, isError)
  }

  abort(): Promise<void> { return this.call.abort() }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    try {
      await this.call.dispose()
    } finally {
      await this.release()
    }
  }
}

export class CopilotRuntimeManager implements CopilotRuntime {
  #runtime: CopilotRuntime | undefined
  #transport: CopilotTransport
  #activeCalls = 0
  #drainWaiters: Array<() => void> = []
  #rotation: Promise<void> | undefined
  #rotationRequested = false

  constructor(
    private readonly factory: CopilotRuntimeFactory,
    initialTransport: CopilotTransport = { mode: 'direct' },
  ) {
    this.#transport = initialTransport
  }

  get transport(): CopilotTransport { return this.#transport }

  async setTransport(transport: CopilotTransport): Promise<void> {
    if (transport.mode === this.#transport.mode && transport.proxyUrl === this.#transport.proxyUrl && transport.caPath === this.#transport.caPath) return
    this.#transport = transport
    this.#rotationRequested = true
    await this.#scheduleRotation()
  }

  async start(): Promise<void> { await this.#current().start() }

  async stop(): Promise<void> {
    await this.#waitForDrain()
    const runtime = this.#runtime
    this.#runtime = undefined
    await runtime?.stop()
  }

  async getAuthStatus(): Promise<RuntimeAuthStatus> { return this.#current().getAuthStatus() }

  async listModels(): Promise<readonly RuntimeModel[]> { return this.#current().listModels() }

  async startCall(request: RuntimeCallRequest): Promise<ActiveRuntimeCall> {
    const runtime = this.#current()
    this.#activeCalls += 1
    let call: ActiveRuntimeCall
    try {
      call = await runtime.startCall(request)
    } catch (error) {
      this.#activeCalls -= 1
      this.#releaseDrainWaiters()
      throw error
    }
    return new ManagedActiveCall(call, async () => {
      this.#activeCalls -= 1
      if (this.#activeCalls === 0) {
        this.#releaseDrainWaiters()
        await this.#scheduleRotation()
      }
    })
  }

  async #scheduleRotation(): Promise<void> {
    const previous = this.#rotation
    const rotation = (previous ?? Promise.resolve()).then(() => this.#rotateWhenIdle())
    this.#rotation = rotation.finally(() => {
      if (this.#rotation === rotation) this.#rotation = undefined
    })
    await rotation
  }

  async #rotateWhenIdle(): Promise<void> {
    if (!this.#rotationRequested) return
    if (this.#activeCalls > 0) {
      await this.#waitForDrain()
    }
    const runtime = this.#runtime
    if (runtime === undefined) return
    this.#rotationRequested = false
    this.#runtime = undefined
    await runtime.stop()
  }

  #current(): CopilotRuntime {
    this.#runtime ??= this.factory.create(this.#transport)
    return this.#runtime
  }

  #waitForDrain(): Promise<void> {
    if (this.#activeCalls === 0) return Promise.resolve()
    return new Promise((resolve) => this.#drainWaiters.push(resolve))
  }

  #releaseDrainWaiters(): void {
    const waiters = this.#drainWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }
}
