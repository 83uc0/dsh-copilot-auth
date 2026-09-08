import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AsyncQueue } from '../src/async-queue.js'
import { CopilotRuntimeManager, memoizeAsync, resolveCliPath, toRuntimeModel, toSdkTools, toSessionError, type ActiveRuntimeCall, type CopilotRuntime, type CopilotTransport, type RuntimeAuthStatus, type RuntimeEvent, type RuntimeModel } from '../src/copilot-runtime.js'

const CLI_NAME = process.platform === 'win32' ? 'copilot.cmd' : 'copilot'

describe('resolveCliPath', () => {
  const createdDirectories: string[] = []

  afterEach(() => {
    for (const directory of createdDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  function tempDirectoryWithExecutable(): string {
    const directory = mkdtempSync(join(tmpdir(), 'copilot-cli-test-'))
    createdDirectories.push(directory)
    const filePath = join(directory, CLI_NAME)
    writeFileSync(filePath, '#!/bin/sh\nexit 0\n')
    chmodSync(filePath, 0o755)
    return directory
  }

  it('returns an explicit path unchanged instead of searching PATH', () => {
    expect(resolveCliPath('/usr/local/bin/copilot', { PATH: '' })).toBe('/usr/local/bin/copilot')
    expect(resolveCliPath('./copilot', { PATH: '' })).toBe('./copilot')
  })

  it('resolves a bare command found on PATH to its absolute path', () => {
    const directory = tempDirectoryWithExecutable()
    expect(resolveCliPath('copilot', { PATH: directory })).toBe(join(directory, CLI_NAME))
  })

  it('returns undefined when the bare command is not found on PATH', () => {
    const directory = mkdtempSync(join(tmpdir(), 'copilot-cli-test-'))
    createdDirectories.push(directory)
    expect(resolveCliPath('copilot', { PATH: directory })).toBeUndefined()
  })

  it('returns undefined when PATH is unset so the caller can fall back to the bundled runtime', () => {
    expect(resolveCliPath('copilot', {})).toBeUndefined()
  })
})

describe('toSessionError', () => {
  it('surfaces the real message and classification hints instead of "Unknown GitHub Copilot error"', () => {
    const error = toSessionError({ errorType: 'authentication', message: 'Please sign in again', statusCode: 401 })
    expect(error.message).toBe('Please sign in again (authentication 401)')
  })

  it('appends only the hints that are present', () => {
    const error = toSessionError({ errorType: 'query', message: 'The request could not be completed' })
    expect(error.message).toBe('The request could not be completed (query)')
  })

  it('redacts secret-shaped content in the underlying message', () => {
    const error = toSessionError({ errorType: 'authorization', message: 'Rejected Bearer super-secret', statusCode: 403 })
    expect(error.message).not.toContain('super-secret')
  })
})

describe('toRuntimeModel', () => {
  const capabilities = {
    supports: { vision: false, reasoningEffort: false },
    limits: { max_context_window_tokens: 128_000 },
  }

  it('treats enabled models as selectable while preserving identity', () => {
    const model = toRuntimeModel({
      id: 'claude-sonnet-4.5',
      name: 'Claude Sonnet 4.5',
      capabilities,
      policy: { state: 'enabled', terms: 'user' },
      supportedReasoningEfforts: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'medium',
    })

    expect(model).toMatchObject({
      id: 'claude-sonnet-4.5',
      name: 'Claude Sonnet 4.5',
      enabled: true,
      reasoningEfforts: ['low', 'medium', 'high'],
      defaultReasoningEffort: 'medium',
    })
  })

  it('keeps unconfigured models visible because they are usable when not explicitly disabled', () => {
    const model = toRuntimeModel({
      id: 'gpt-5.6-terra',
      name: 'GPT-5.6 Terra',
      capabilities,
      policy: { state: 'unconfigured', terms: 'not set' },
    })

    expect(model).toMatchObject({
      id: 'gpt-5.6-terra',
      name: 'GPT-5.6 Terra',
      enabled: true,
    })
  })

  it('filters out models explicitly disabled by policy', () => {
    const model = toRuntimeModel({
      id: 'grok-4.6',
      name: 'Grok 4.6',
      capabilities,
      policy: { state: 'disabled', terms: 'opt-out' },
    })

    expect(model).toMatchObject({
      id: 'grok-4.6',
      name: 'Grok 4.6',
      enabled: false,
    })
  })

  it('keeps the synthetic Auto model available without mutating its identifier or name', () => {
    const model = toRuntimeModel({
      id: 'auto',
      name: 'Auto',
      capabilities,
      policy: { state: 'unconfigured', terms: 'synthetic' },
    })

    expect(model).toMatchObject({
      id: 'auto',
      name: 'Auto',
      enabled: true,
    })
  })
})

describe('toSdkTools', () => {
  it('overrides built-in tools so a same-named DSH tool (e.g. "bash") does not reject session creation', () => {
    const [tool] = toSdkTools([{ name: 'bash', description: 'Run a shell command', parameters: {} }])
    expect(tool).toMatchObject({
      name: 'bash',
      description: 'Run a shell command',
      skipPermission: true,
      defer: 'never',
      overridesBuiltInTool: true,
    })
  })
})

describe('memoizeAsync', () => {
  it('runs the factory only once for concurrent callers, closing the double-start race', async () => {
    let calls = 0
    let resolveFactory: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      resolveFactory = resolve
    })
    const memoized = memoizeAsync(() => {
      calls += 1
      return gate
    })

    const first = memoized.run()
    const second = memoized.run()
    resolveFactory()
    await Promise.all([first, second])

    expect(calls).toBe(1)
  })

  it('clears the cache on rejection so a later call retries', async () => {
    let calls = 0
    const memoized = memoizeAsync(() => {
      calls += 1
      return calls === 1 ? Promise.reject(new Error('transient')) : Promise.resolve()
    })

    await expect(memoized.run()).rejects.toThrow('transient')
    await expect(memoized.run()).resolves.toBeUndefined()
    expect(calls).toBe(2)
  })

  it('reset reports whether a cached attempt existed and clears it', async () => {
    const memoized = memoizeAsync(() => Promise.resolve())
    expect(memoized.reset()).toBe(false)

    await memoized.run()
    expect(memoized.reset()).toBe(true)
    expect(memoized.reset()).toBe(false)
  })
})

describe('CopilotRuntimeManager', () => {
  class ManagedCall implements ActiveRuntimeCall {
    readonly events: AsyncIterable<RuntimeEvent> = new AsyncQueue<RuntimeEvent>()
    async respondToTool(): Promise<void> {}
    async abort(): Promise<void> {}
    async dispose(): Promise<void> {}
  }

  class Runtime implements CopilotRuntime {
    stopped = false

    async start(): Promise<void> {}
    async stop(): Promise<void> { this.stopped = true }
    async getAuthStatus(): Promise<RuntimeAuthStatus> { return { isAuthenticated: true } }
    async listModels(): Promise<readonly RuntimeModel[]> { return [] }
    async startCall(): Promise<ActiveRuntimeCall> {
      return new ManagedCall()
    }
  }

  it('creates direct transport by default and reuses it without rotation', async () => {
    const transports: CopilotTransport[] = []
    const runtimes: Runtime[] = []
    const manager = new CopilotRuntimeManager({ create: (transport) => { transports.push(transport); const runtime = new Runtime(); runtimes.push(runtime); return runtime } })
    await manager.listModels()
    await manager.listModels()
    expect(transports).toEqual([{ mode: 'direct' }])
    expect(runtimes[0]?.stopped).toBe(false)
  })

  it('changes transport only after active call drains, then creates next generation', async () => {
    const transports: CopilotTransport[] = []
    const runtimes: Runtime[] = []
    const manager = new CopilotRuntimeManager({ create: (transport) => { transports.push(transport); const runtime = new Runtime(); runtimes.push(runtime); return runtime } })
    const call = await manager.startCall({ model: 'gpt-test', prompt: 'safe test content', tools: [] })
    const rotation = manager.setTransport({ mode: 'edgee', proxyUrl: 'http://127.0.0.1:41500', caPath: '/public/ca.pem' })
    await Promise.resolve()
    expect(runtimes[0]?.stopped).toBe(false)
    let rotated = false
    void rotation.then(() => { rotated = true })
    await Promise.resolve()
    expect(rotated).toBe(false)
    await call.dispose()
    await rotation
    expect(runtimes[0]?.stopped).toBe(true)
    expect(transports).toEqual([{ mode: 'direct' }])
    await manager.listModels()
    expect(transports).toEqual([{ mode: 'direct' }, { mode: 'edgee', proxyUrl: 'http://127.0.0.1:41500', caPath: '/public/ca.pem' }])
  })

  it('rotates Edgee back to direct without exposing secrets', async () => {
    const transports: CopilotTransport[] = []
    const manager = new CopilotRuntimeManager({ create: (transport) => { transports.push(transport); return new Runtime() } }, { mode: 'edgee', proxyUrl: 'http://127.0.0.1:41500', caPath: '/public/ca.pem' })
    await manager.start()
    await manager.setTransport({ mode: 'direct' })
    expect(transports).toEqual([{ mode: 'edgee', proxyUrl: 'http://127.0.0.1:41500', caPath: '/public/ca.pem' }])
    await manager.start()
    expect(transports.at(-1)).toEqual({ mode: 'direct' })
    expect(JSON.stringify(transports)).not.toMatch(/token|authorization|credential/i)
  })
})
