import type { AuthorizationService } from '@deepseek-ai/dsh-authorization'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import { CopilotAuthController } from '../src/auth.js'
import type { ActiveRuntimeCall, CopilotRuntime, LoginRunner, RuntimeAuthStatus, RuntimeCallRequest, RuntimeModel } from '../src/copilot-runtime.js'

class MockCredentials {
  record: CredentialRecord | undefined
  deleted = false

  async modifyRecord(_key: unknown, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined> {
    this.record = await mutate(this.record)
    return this.record
  }

  async deleteRecord(): Promise<void> {
    this.deleted = true
    this.record = undefined
  }
}

class MockRuntime implements CopilotRuntime {
  status: RuntimeAuthStatus = { isAuthenticated: true, login: 'octocat', host: 'https://github.com' }
  stopCount = 0
  async start(): Promise<void> {}
  async stop(): Promise<void> { this.stopCount += 1 }
  async getAuthStatus(): Promise<RuntimeAuthStatus> { return this.status }
  async listModels(): Promise<readonly RuntimeModel[]> { return [] }
  async startCall(_request: RuntimeCallRequest): Promise<ActiveRuntimeCall> { throw new Error('not used') }
}

class MockRunner implements LoginRunner {
  loginCount = 0
  logoutCount = 0
  async login(): Promise<void> { this.loginCount += 1 }
  async logout(): Promise<void> { this.logoutCount += 1 }
}

function controller(
  credentials: MockCredentials,
  runtime: MockRuntime,
  runner: MockRunner,
  withAuthorization = true,
): CopilotAuthController {
  const authorization = withAuthorization
    ? ({ begin: async () => ({ status: 'authorized' as const }) } as unknown as AuthorizationService)
    : undefined
  return new CopilotAuthController(
    credentials as unknown as CredentialProvider,
    authorization,
    runtime,
    runner,
  )
}

describe('official Copilot authorization bridge', () => {
  it('mocks browser OAuth completion and stores only non-secret account metadata', async () => {
    const credentials = new MockCredentials()
    const runtime = new MockRuntime()
    const runner = new MockRunner()
    const auth = controller(credentials, runtime, runner)
    const notices: string[] = []

    await auth.flow().run({
      method: 'web',
      signal: new AbortController().signal,
      notify: (notice) => notices.push(notice.message),
      prompt: async () => '',
    })

    expect(runner.loginCount).toBe(1)
    expect(notices.join(' ')).toContain('official GitHub Copilot CLI')
    expect(credentials.record).toMatchObject({
      kind: 'grant',
      payload: { provider: 'github-copilot', phase: 'connected', login: 'octocat' },
    })
    expect(JSON.stringify(credentials.record)).not.toMatch(/token|secret|authorization/i)
  })

  it('runs the official CLI login directly when DSH has no authorization service', async () => {
    const credentials = new MockCredentials()
    const runtime = new MockRuntime()
    const runner = new MockRunner()
    const notices: string[] = []
    const text = await controller(credentials, runtime, runner, false).beginLogin(
      new AbortController().signal,
      {
        notify: (notice) => notices.push(notice.message),
        prompt: async () => '',
      },
    )
    expect(runner.loginCount).toBe(1)
    expect(notices).toHaveLength(1)
    expect(text).toContain('octocat')
    expect(credentials.record).toMatchObject({ kind: 'grant', payload: { phase: 'connected' } })
  })

  it('models automatic CLI refresh as a non-secret state synchronization', async () => {
    const credentials = new MockCredentials()
    const runtime = new MockRuntime()
    const runner = new MockRunner()
    const state = await controller(credentials, runtime, runner).refreshState()
    expect(state.phase).toBe('refresh-succeeded')
    expect(state.login).toBe('octocat')
  })

  it('logs out through the official CLI and deletes only the DSH metadata after confirmation', async () => {
    const credentials = new MockCredentials()
    const runtime = new MockRuntime()
    runtime.status = { isAuthenticated: false }
    const runner = new MockRunner()
    await controller(credentials, runtime, runner).logout(new AbortController().signal)
    expect(runner.logoutCount).toBe(1)
    expect(credentials.deleted).toBe(true)
  })
})
