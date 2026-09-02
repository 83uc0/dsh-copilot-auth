import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BillingReportClient,
  DEFAULT_REFRESH_MINUTES,
  MIN_FETCH_INTERVAL_MS,
  billedCreditsByModel,
  billedCreditsTotal,
  parseBillingReport,
} from '../src/billing-report.js'

const TOKEN = 'github_pat_TESTSECRET123'

const REPORT_BODY = JSON.stringify({
  timePeriod: { year: 2026, month: 9 },
  user: 'octocat',
  usageItems: [
    {
      product: 'copilot',
      sku: 'copilot_premium_gpt54',
      model: 'gpt-5.4',
      unitType: 'credits',
      pricePerUnit: 1,
      grossQuantity: 300,
      grossAmount: 3,
      discountQuantity: 300,
      discountAmount: 3,
      netQuantity: 0,
      netAmount: 0,
    },
    {
      product: 'copilot',
      sku: 'copilot_premium_sonnet',
      model: 'claude-sonnet-4.5',
      unitType: 'credits',
      pricePerUnit: 1,
      grossQuantity: 120,
      grossAmount: 1.2,
      discountQuantity: 120,
      discountAmount: 1.2,
      netQuantity: 0,
      netAmount: 0,
    },
  ],
})

function fakeResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return {
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => JSON.parse(body) as unknown,
    body: { cancel: async () => {} },
  } as unknown as Response
}

function failingJsonResponse(): Response {
  return {
    status: 200,
    headers: { get: () => null },
    json: async () => {
      throw new Error('not json')
    },
    body: { cancel: async () => {} },
  } as unknown as Response
}

describe('BillingReportClient', () => {
  let dir: string
  let tokenPath: string
  let nowMs: number
  let logs: string[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'copilot-billing-test-'))
    tokenPath = join(dir, 'billing-token')
    writeFileSync(tokenPath, `${TOKEN}\n`, { mode: 0o600 })
    nowMs = Date.parse('2026-09-01T10:00:00.000Z')
    logs = []
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function client(overrides: {
    fetchFn?: (url: string, init: RequestInit) => Promise<Response>
    tokenPath?: string
    refreshMinutes?: number
  } = {}): BillingReportClient {
    return new BillingReportClient({
      tokenPath: overrides.tokenPath ?? tokenPath,
      fetchFn: overrides.fetchFn ?? (async () => fakeResponse(200, REPORT_BODY)),
      logger: { info: (message) => logs.push(message) },
      now: () => new Date(nowMs),
      ...(overrides.refreshMinutes === undefined ? {} : { refreshMinutes: overrides.refreshMinutes }),
    })
  }

  it('runs estimate-only when no billing token is configured', async () => {
    const unconfigured = new BillingReportClient({ logger: { info: () => {} } })
    expect(unconfigured.configured).toBe(false)
    const result = await unconfigured.report('octocat', { year: 2026, month: 9 })
    expect(result).toMatchObject({ ok: false, reason: 'no-token-configured' })
  })

  it('fetches with the dedicated PAT, API version header, and GET only', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const result = await client({
      fetchFn: async (url, init) => {
        seen.push({ url, init })
        return fakeResponse(200, REPORT_BODY)
      },
    }).report('octocat', { year: 2026, month: 9 })

    expect(result.ok).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('https://api.github.com/users/octocat/settings/billing/ai_credit/usage?year=2026&month=9')
    expect(seen[0]?.init.method).toBe('GET')
    const headers = seen[0]?.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(headers['x-github-api-version']).toBeDefined()
    if (result.ok) {
      expect(billedCreditsTotal(result.report)).toBe(420)
      expect(billedCreditsByModel(result.report).get('gpt-5.4')).toBe(300)
      expect(result.fromCache).toBe(false)
    }
  })

  it('serves the cached report within the TTL and refreshes when forced', async () => {
    let fetches = 0
    const c = client({
      fetchFn: async () => {
        fetches += 1
        return fakeResponse(200, REPORT_BODY)
      },
    })
    await c.report('octocat', { year: 2026, month: 9 })
    const cached = await c.report('octocat', { year: 2026, month: 9 })
    expect(fetches).toBe(1)
    expect(cached.ok && cached.fromCache).toBe(true)

    // Forced refresh still respects the hard floor between network calls.
    const tooSoon = await c.report('octocat', { year: 2026, month: 9 }, { force: true })
    expect(fetches).toBe(1)
    expect(tooSoon.ok && tooSoon.fromCache).toBe(true)

    nowMs += MIN_FETCH_INTERVAL_MS + 1000
    const forced = await c.report('octocat', { year: 2026, month: 9 }, { force: true })
    expect(fetches).toBe(2)
    expect(forced.ok && forced.fromCache).toBe(false)
  })

  it('clamps a below-minimum refresh interval and says so', () => {
    const c = client({ refreshMinutes: 5 })
    expect(c.refreshMinutes).toBe(DEFAULT_REFRESH_MINUTES)
    expect(logs.some((message) => message.includes('below the enforced minimum'))).toBe(true)
  })

  it('warns when the token file permissions are wider than 0600', async () => {
    chmodSync(tokenPath, 0o644)
    const result = await client().report('octocat', { year: 2026, month: 9 })
    expect(result.ok).toBe(true)
    expect(logs.some((message) => message.includes('chmod 600'))).toBe(true)
  })

  it('maps 401, 404, 429 and unexpected statuses to explicit reasons', async () => {
    for (const [status, reason] of [[401, 'http-401'], [404, 'http-404'], [429, 'http-429'], [500, 'http-error']] as const) {
      const result = await client({ fetchFn: async () => fakeResponse(status, '{}') }).report('octocat', {
        year: 2026,
        month: 9,
      })
      expect(result).toMatchObject({ ok: false, reason, status })
    }
  })

  it('logs X-Accepted-GitHub-Permissions on 403 — and never the token', async () => {
    const result = await client({
      fetchFn: async () => fakeResponse(403, '{}', { 'x-accepted-github-permissions': 'plan' }),
    }).report('octocat', { year: 2026, month: 9 })

    expect(result).toMatchObject({ ok: false, reason: 'http-403', acceptedPermissions: 'plan' })
    expect(logs.some((message) => message.includes('plan'))).toBe(true)
    for (const message of logs) expect(message).not.toContain(TOKEN)
  })

  it('reports endpoint unavailability and invalid responses without throwing', async () => {
    const down = await client({
      fetchFn: async () => {
        throw new Error('ECONNREFUSED')
      },
    }).report('octocat', { year: 2026, month: 9 })
    expect(down).toMatchObject({ ok: false, reason: 'endpoint-unavailable' })

    const notJson = await client({ fetchFn: async () => failingJsonResponse() }).report('octocat', { year: 2026, month: 9 })
    expect(notJson).toMatchObject({ ok: false, reason: 'invalid-response' })

    const wrongShape = await client({ fetchFn: async () => fakeResponse(200, '{"hello":"world"}') }).report('octocat', {
      year: 2026,
      month: 9,
    })
    expect(wrongShape).toMatchObject({ ok: false, reason: 'invalid-response' })
  })

  it('accepts an empty usageItems array (plan without data this period)', async () => {
    const result = await client({
      fetchFn: async () => fakeResponse(200, JSON.stringify({ timePeriod: { year: 2026, month: 9 }, user: 'octocat', usageItems: [] })),
    }).report('octocat', { year: 2026, month: 9 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(billedCreditsTotal(result.report)).toBe(0)
  })

  it('reports an unreadable or empty token file distinctly', async () => {
    const missing = await client({ tokenPath: join(dir, 'nope') }).report('octocat', { year: 2026, month: 9 })
    expect(missing).toMatchObject({ ok: false, reason: 'token-unreadable' })
    writeFileSync(join(dir, 'empty'), '')
    const empty = await client({ tokenPath: join(dir, 'empty') }).report('octocat', { year: 2026, month: 9 })
    expect(empty).toMatchObject({ ok: false, reason: 'token-unreadable' })
  })

  it('never logs the token on any failure path', async () => {
    for (const status of [400, 401, 403, 500, 503]) {
      logs = []
      await client({ fetchFn: async () => fakeResponse(status, `{"token":"${TOKEN}"}`) }).report('octocat', {
        year: 2026,
        month: 9,
      })
      expect(logs.join('\n')).not.toContain(TOKEN)
    }
  })
})

describe('parseBillingReport', () => {
  it('rejects non-conforming payloads instead of guessing', () => {
    expect(parseBillingReport(undefined)).toBeUndefined()
    expect(parseBillingReport({})).toBeUndefined()
    expect(parseBillingReport({ timePeriod: { year: 'x' }, usageItems: [] })).toBeUndefined()
    expect(parseBillingReport({ timePeriod: { year: 2026 }, usageItems: 'nope' })).toBeUndefined()
  })

  it('keeps only well-formed usage items', () => {
    const report = parseBillingReport({
      timePeriod: { year: 2026, month: 9 },
      user: 'octocat',
      usageItems: [
        { model: 'gpt-5.4', grossQuantity: 12 },
        { model: 'broken' },
      ],
    })
    expect(report?.usageItems).toHaveLength(1)
    expect(report?.usageItems[0]?.model).toBe('gpt-5.4')
  })
})
