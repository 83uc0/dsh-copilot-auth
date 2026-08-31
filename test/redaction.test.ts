import { describe, expect, it } from 'vitest'
import { redactHeaders, redactText, redactUnknown } from '../src/redaction.js'

describe('redaction', () => {
  it('redacts bearer and GitHub token families', () => {
    const fakeGitHubToken = ['ghp', 'fake-value'].join('_')
    const input = `Authorization: Bearer abc.def and ${fakeGitHubToken} and github_pat_fake`
    const output = redactText(input)
    expect(output).not.toContain('abc.def')
    expect(output).not.toContain('fake-value')
    expect(output).not.toContain('github_pat_fake')
  })

  it('redacts secret header values and nested error fields', () => {
    expect(redactHeaders({ authorization: 'Bearer secret', accept: 'application/json' })).toEqual({
      authorization: '[REDACTED]',
      accept: 'application/json',
    })
    expect(redactUnknown({ refreshToken: 'secret', nested: { message: 'Bearer value' } })).toEqual({
      refreshToken: '[REDACTED]',
      nested: { message: 'Bearer [REDACTED]' },
    })
  })

  it('redacts sensitive query values', () => {
    expect(redactText('https://example.test/cb?code=oauth-code&ok=1')).toBe(
      'https://example.test/cb?code=[REDACTED]&ok=1',
    )
  })
})
