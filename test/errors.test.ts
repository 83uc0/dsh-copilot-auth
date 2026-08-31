import { describe, expect, it } from 'vitest'
import { classifyCopilotError } from '../src/errors.js'

describe('Copilot error classification', () => {
  it.each([
    ['401 unauthorized', 'AUTH_REQUIRED', 401],
    ['403 account has no entitlement', 'ACCOUNT_NOT_ENTITLED', 403],
    ['403 model policy disabled', 'MODEL_NOT_AUTHORIZED', 403],
    ['429 Too Many Requests', 'RATE_LIMIT', 429],
  ])('maps %s', (message, code, status) => {
    const error = classifyCopilotError(new Error(message))
    expect(error.code).toBe(code)
    expect(error.failure.status).toBe(status)
  })

  it('never includes a bearer credential in the exposed message', () => {
    const error = classifyCopilotError(new Error('stream failed Bearer super-secret'))
    expect(error.message).not.toContain('super-secret')
  })
})
