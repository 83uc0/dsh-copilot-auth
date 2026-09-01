import { LlmError } from '@deepseek-ai/dsh-llm'
import { safeErrorMessage } from './redaction.js'

export type CopilotFailureCode =
  | 'AUTH_REQUIRED'
  | 'ACCOUNT_NOT_ENTITLED'
  | 'MODEL_NOT_AUTHORIZED'
  | 'RATE_LIMIT'
  | 'STREAM_ERROR'
  | 'COPILOT_RUNTIME_ERROR'

function statusFromText(message: string): number | undefined {
  const match = /(?:^|\D)(401|403|429)(?:\D|$)/.exec(message)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

export function classifyCopilotError(error: unknown): LlmError {
  const message = safeErrorMessage(error)
  const status = statusFromText(message)
  if (status === 401 || /not authenticated|login required|unauthori[sz]ed/i.test(message)) {
    return new LlmError('GitHub Copilot authentication is required; run /login github-copilot-sdk', 'AUTH_REQUIRED', {
      status: 401,
      cause: error,
    })
  }
  if (status === 403 && /model|policy/i.test(message)) {
    return new LlmError('This GitHub Copilot model is not authorized for the current account', 'MODEL_NOT_AUTHORIZED', {
      status,
      cause: error,
    })
  }
  if (status === 403) {
    return new LlmError('The current GitHub account is not entitled to GitHub Copilot', 'ACCOUNT_NOT_ENTITLED', {
      status,
      cause: error,
    })
  }
  if (status === 429 || /rate.?limit|too many requests/i.test(message)) {
    return new LlmError('GitHub Copilot rate limit reached', 'RATE_LIMIT', { status: 429, cause: error })
  }
  if (/stream|socket|connection closed|eof/i.test(message)) {
    return new LlmError(`GitHub Copilot streaming failed: ${message}`, 'STREAM_ERROR', { cause: error })
  }
  return new LlmError(`GitHub Copilot runtime failed: ${message}`, 'COPILOT_RUNTIME_ERROR', { cause: error })
}
