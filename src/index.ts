import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-authorization'
import '@deepseek-ai/dsh-commands'
import '@deepseek-ai/dsh-credentials'
import '@deepseek-ai/dsh-llm'
import { GitHubCopilotAdapter } from './adapter.js'
import { CopilotAuthController } from './auth.js'
import { commandDefinitions } from './commands.js'
import { CopilotCliLoginRunner, OfficialCopilotRuntime } from './copilot-runtime.js'

export const name = 'llm-github-copilot'
export const inject = ['llm', 'credentials', 'commands']

export function apply(ctx: Context): void {
  const runtime = new OfficialCopilotRuntime(process.cwd())
  const adapter = new GitHubCopilotAdapter(runtime)
  const authorization = ctx.get('authorization')
  const auth = new CopilotAuthController(
    ctx.credentials,
    authorization,
    runtime,
    new CopilotCliLoginRunner(),
  )

  ctx.effect(function* githubCopilotLifecycle() {
    yield ctx.llm.registerAdapter(['github-copilot'], adapter)
    if (authorization !== undefined) yield authorization.registerFlow(auth.flow())
    for (const command of commandDefinitions(auth)) yield ctx.commands.register(command)
    yield async () => adapter.dispose()
  }, 'official GitHub Copilot adapter lifecycle')
}

export { GitHubCopilotAdapter } from './adapter.js'
export { CopilotAuthController, COPILOT_CREDENTIAL_KEY } from './auth.js'
export type {
  ActiveRuntimeCall,
  CopilotRuntime,
  LoginRunner,
  RuntimeAuthStatus,
  RuntimeCallRequest,
  RuntimeEvent,
  RuntimeModel,
  RuntimeTool,
} from './copilot-runtime.js'
export { classifyCopilotError } from './errors.js'
export { parseAuthState } from './auth-state.js'
export { redactHeaders, redactText, redactUnknown, safeErrorMessage } from './redaction.js'
