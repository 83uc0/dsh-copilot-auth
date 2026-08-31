export const AUTH_STATE_VERSION = 1

export type AuthPhase =
  | 'disconnected'
  | 'login-in-progress'
  | 'connected'
  | 'expired'
  | 'refresh-succeeded'
  | 'refresh-failed'
  | 'account-not-entitled'

export interface CopilotAuthState {
  readonly version: typeof AUTH_STATE_VERSION
  readonly provider: 'github-copilot'
  readonly phase: AuthPhase
  readonly login?: string
  readonly host?: string
  readonly updatedAt: string
  readonly message?: string
}

const PHASES = new Set<AuthPhase>([
  'disconnected',
  'login-in-progress',
  'connected',
  'expired',
  'refresh-succeeded',
  'refresh-failed',
  'account-not-entitled',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseAuthState(value: unknown): CopilotAuthState | undefined {
  if (!isRecord(value)) return undefined
  if (value.version !== AUTH_STATE_VERSION || value.provider !== 'github-copilot') return undefined
  if (typeof value.phase !== 'string' || !PHASES.has(value.phase as AuthPhase)) return undefined
  if (typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))) return undefined
  if (value.login !== undefined && typeof value.login !== 'string') return undefined
  if (value.host !== undefined && typeof value.host !== 'string') return undefined
  if (value.message !== undefined && typeof value.message !== 'string') return undefined
  return {
    version: AUTH_STATE_VERSION,
    provider: 'github-copilot',
    phase: value.phase as AuthPhase,
    updatedAt: value.updatedAt,
    ...(typeof value.login === 'string' ? { login: value.login } : {}),
    ...(typeof value.host === 'string' ? { host: value.host } : {}),
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
  }
}

export function authState(input: Omit<CopilotAuthState, 'version' | 'provider' | 'updatedAt'>): CopilotAuthState {
  return {
    version: AUTH_STATE_VERSION,
    provider: 'github-copilot',
    updatedAt: new Date().toISOString(),
    ...input,
  }
}
