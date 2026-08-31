const SECRET_KEY = /(?:authorization|cookie|token|secret|api[-_]?key|credential|refresh|access)/i
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const GITHUB_TOKEN = /\b(?:gh[opusr]_|github_pat_)[A-Za-z0-9_]+\b/gi
const COPILOT_TOKEN = /\b(?:tid|exp|proxy-ep)=[^\s;]+(?:;[^\s]+)*/gi

export const REDACTED = '[REDACTED]'

export function redactText(value: string): string {
  return value
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(GITHUB_TOKEN, REDACTED)
    .replace(COPILOT_TOKEN, REDACTED)
    .replace(/([?&](?:access_token|refresh_token|token|code)=)[^&#\s]+/gi, `$1${REDACTED}`)
}

export function redactHeaders(headers: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, SECRET_KEY.test(key) ? REDACTED : redactUnknown(value)]),
  )
}

export function redactUnknown(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      ...('code' in value && typeof value.code === 'string' ? { code: value.code } : {}),
    }
  }
  if (Array.isArray(value)) return value.map((entry) => redactUnknown(entry, seen))
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, SECRET_KEY.test(key) ? REDACTED : redactUnknown(entry, seen)]),
  )
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return redactText(error.message)
  if (typeof error === 'string') return redactText(error)
  return 'Unknown GitHub Copilot error'
}
