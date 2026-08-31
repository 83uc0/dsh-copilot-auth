import type { AuthorizationFlow, AuthorizationInteraction } from '@deepseek-ai/dsh-authorization'
import { credentialKey, type CredentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationService } from '@deepseek-ai/dsh-authorization'
import { authState, type CopilotAuthState } from './auth-state.js'
import type { CopilotRuntime, LoginRunner, RuntimeAuthStatus } from './copilot-runtime.js'
import { safeErrorMessage } from './redaction.js'

export const COPILOT_CREDENTIAL_KEY: CredentialKey = credentialKey('llm-github-copilot', 'github-copilot')

function stateFromStatus(status: RuntimeAuthStatus, phase: CopilotAuthState['phase'] = 'connected'): CopilotAuthState {
  return authState({
    phase: status.isAuthenticated ? phase : 'disconnected',
    ...(status.login === undefined ? {} : { login: status.login }),
    ...(status.host === undefined ? {} : { host: status.host }),
    ...(status.statusMessage === undefined ? {} : { message: status.statusMessage }),
  })
}

export class CopilotAuthController {
  constructor(
    private readonly credentials: CredentialProvider,
    private readonly authorization: AuthorizationService | undefined,
    private readonly runtime: CopilotRuntime,
    private readonly runner: LoginRunner,
  ) {}

  flow(): AuthorizationFlow {
    return {
      key: COPILOT_CREDENTIAL_KEY,
      label: 'GitHub Copilot (official CLI)',
      methods: [{ id: 'web', label: 'Sign in through GitHub in your browser' }],
      run: async (session) => {
        session.notify({ message: 'The official GitHub Copilot CLI is opening the GitHub authorization page in your browser.' })
        await this.#login(session.signal)
      },
    }
  }

  async beginLogin(signal: AbortSignal, interaction: AuthorizationInteraction): Promise<string> {
    if (this.authorization !== undefined) {
      const result = await this.authorization.begin({
        key: COPILOT_CREDENTIAL_KEY,
        method: 'web',
        interaction,
        signal,
      })
      if (result.status === 'cancelled') return 'GitHub Copilot login was cancelled.'
    } else {
      interaction.notify({ message: 'The official GitHub Copilot CLI is opening the GitHub authorization page in your browser.' })
      await this.#login(signal)
    }
    const status = await this.runtime.getAuthStatus()
    return status.login === undefined
      ? 'GitHub Copilot is connected.'
      : `GitHub Copilot is connected as ${status.login}.`
  }

  async logout(signal: AbortSignal): Promise<string> {
    await this.runner.logout(signal)
    await this.runtime.stop()
    const status = await this.runtime.getAuthStatus()
    if (status.isAuthenticated) {
      throw new Error('The official Copilot CLI still reports an authenticated account; run copilot interactively and enter /logout')
    }
    await this.credentials.deleteRecord(COPILOT_CREDENTIAL_KEY)
    return 'GitHub Copilot CLI credentials were removed. The DSH non-secret account record was also deleted.'
  }

  async refreshState(): Promise<CopilotAuthState> {
    try {
      const status = await this.runtime.getAuthStatus()
      const next = stateFromStatus(status, status.isAuthenticated ? 'refresh-succeeded' : 'expired')
      await this.#store(next)
      return next
    } catch (error) {
      const next = authState({ phase: 'refresh-failed', message: safeErrorMessage(error) })
      await this.#store(next)
      return next
    }
  }

  async #login(signal: AbortSignal): Promise<void> {
    await this.runner.login(signal)
    await this.runtime.stop()
    const status = await this.runtime.getAuthStatus()
    if (!status.isAuthenticated) {
      throw new Error(status.statusMessage ?? 'GitHub Copilot CLI did not report an authenticated account')
    }
    await this.#store(stateFromStatus(status))
  }

  async #store(state: CopilotAuthState): Promise<void> {
    await this.credentials.modifyRecord(COPILOT_CREDENTIAL_KEY, async () => ({ kind: 'grant', payload: state }))
  }
}
