import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type { CopilotAuthController } from './auth.js'
import { safeErrorMessage } from './redaction.js'

function acceptsProvider(rawInput: string): boolean {
  return rawInput.trim() === 'github-copilot'
}

export function commandDefinitions(auth: CopilotAuthController): readonly CommandDefinition[] {
  return [
    {
      name: 'login',
      description: 'Log in to an LLM provider (github-copilot)',
      input: { hint: 'github-copilot' },
      handler: async ({ rawInput, signal }) => {
        if (!acceptsProvider(rawInput)) {
          return { kind: 'error', text: 'Usage: /login github-copilot' }
        }
        try {
          const notices: string[] = []
          const text = await auth.beginLogin(signal, {
            notify: (notice) => notices.push(notice.message),
            prompt: async () => {
              throw new AuthorizationDeclinedError('The official Copilot browser flow does not accept text input in DSH')
            },
          })
          return { kind: 'success', text: [...notices, text].join('\n') }
        } catch (error) {
          return { kind: 'error', text: safeErrorMessage(error) }
        }
      },
    },
    {
      name: 'logout',
      description: 'Log out from an LLM provider (github-copilot)',
      input: { hint: 'github-copilot' },
      handler: async ({ rawInput, signal }) => {
        if (!acceptsProvider(rawInput)) {
          return { kind: 'error', text: 'Usage: /logout github-copilot' }
        }
        try {
          return { kind: 'success', text: await auth.logout(signal) }
        } catch (error) {
          return { kind: 'error', text: safeErrorMessage(error) }
        }
      },
    },
    {
      name: 'copilot-status',
      description: 'Refresh and show the non-secret GitHub Copilot authentication state',
      handler: async () => {
        const state = await auth.refreshState()
        const account = state.login === undefined ? '' : ` (${state.login})`
        return state.phase === 'refresh-succeeded'
          ? { kind: 'success', text: `GitHub Copilot is connected${account}.` }
          : { kind: 'error', text: `GitHub Copilot state: ${state.phase}${state.message === undefined ? '' : ` — ${state.message}`}` }
      },
    },
  ]
}
