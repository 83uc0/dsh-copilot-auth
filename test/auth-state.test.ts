import { describe, expect, it } from 'vitest'
import { authState, parseAuthState } from '../src/auth-state.js'

describe('Copilot non-secret auth state', () => {
  it('round-trips a valid state', () => {
    const state = authState({ phase: 'connected', login: 'octocat', host: 'https://github.com' })
    expect(parseAuthState(state)).toEqual(state)
  })

  it('rejects malformed or secret-shaped legacy data', () => {
    expect(parseAuthState({ version: 1, provider: 'github-copilot', phase: 'connected' })).toBeUndefined()
    expect(parseAuthState({ version: 1, provider: 'other', phase: 'connected', updatedAt: new Date().toISOString() })).toBeUndefined()
  })
})
