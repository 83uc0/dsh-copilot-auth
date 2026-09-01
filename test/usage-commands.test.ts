import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { CopilotAuthController } from '../src/auth.js'
import { BillingReportClient } from '../src/billing-report.js'
import { commandDefinitions, type UsageCommandDeps } from '../src/commands.js'
import { estimateVsBilled } from '../src/usage-report.js'
import { UsageStore } from '../src/usage-store.js'
import { ConsumptionTracker } from '../src/usage-tracker.js'

const FIXED_NOW = new Date('2026-09-10T12:00:00.000Z')
const TOKEN = 'github_pat_TESTSECRET123'

const auth = {
  refreshState: async () => ({ phase: 'refresh-succeeded' as const, login: 'octocat' }),
} as unknown as CopilotAuthController

function run(definition: CommandDefinition, rawInput: string) {
  return definition.handler({
    rawInput,
    signal: new AbortController().signal,
    commandId: 'test-command',
    agent: {},
    attachments: [],
  } as never)
}

function billingBody(grossQuantity: number): string {
  return JSON.stringify({
    timePeriod: { year: 2026, month: 9 },
    user: 'octocat',
    usageItems:
      grossQuantity === 0
        ? []
        : [
            {
              product: 'copilot',
              sku: 'sku',
              model: 'gpt-5.4',
              unitType: 'credits',
              pricePerUnit: 1,
              grossQuantity,
              grossAmount: grossQuantity / 100,
              discountQuantity: grossQuantity,
              discountAmount: grossQuantity / 100,
              netQuantity: 0,
              netAmount: 0,
            },
          ],
  })
}

function fakeFetch(status: number, body: string, headers: Record<string, string> = {}) {
  return async (): Promise<Response> =>
    ({
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: async () => JSON.parse(body) as unknown,
      body: { cancel: async () => {} },
    }) as unknown as Response
}

describe('usage commands', () => {
  it('accepts the deprecated alias and canonical login route', async () => {
    const auth = {
      beginLogin: async () => 'login started',
      logout: async () => 'logged out',
      refreshState: async () => ({ phase: 'refresh-succeeded', login: 'octocat' }),
    }
    const commands = commandDefinitions(auth as never)
    const login = commands.find((command) => command.name === 'login')
    if (login === undefined) throw new Error('missing login command')

    expect(await login.handler({ rawInput: 'github-copilot', signal: new AbortController().signal, commandId: 'test-command', agent: {}, attachments: [] } as never)).toMatchObject({ kind: 'success' })
    expect(await login.handler({ rawInput: 'github-copilot-sdk', signal: new AbortController().signal, commandId: 'test-command', agent: {}, attachments: [] } as never)).toMatchObject({ kind: 'success' })
  })

  let dir: string
  let storePath: string
  let tokenPath: string
  let logs: string[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'copilot-usage-commands-'))
    storePath = join(dir, 'usage.json')
    tokenPath = join(dir, 'billing-token')
    writeFileSync(tokenPath, TOKEN, { mode: 0o600 })
    logs = []
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  interface Harness {
    tracker: ConsumptionTracker
    store: UsageStore | undefined
    commands: readonly CommandDefinition[]
    byName: (name: string) => CommandDefinition
  }

  function harness(options: {
    persisted?: boolean
    billing?: boolean
    fetchFn?: (url: string, init: RequestInit) => Promise<Response>
    allocationCredits?: number
    enabled?: boolean
  } = {}): Harness {
    const tracker = new ConsumptionTracker({
      now: () => FIXED_NOW,
      logger: { info: (message) => logs.push(message) },
      ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    })
    const store = options.persisted === true ? new UsageStore(storePath, { info: (m) => logs.push(m) }) : undefined
    if (store !== undefined) {
      const data = store.load()
      if (data !== undefined) tracker.hydrate(data)
      tracker.attachStore(store)
    }
    const billing = new BillingReportClient({
      ...(options.billing === true ? { tokenPath } : {}),
      fetchFn: options.fetchFn ?? fakeFetch(200, billingBody(300)),
      logger: { info: (message) => logs.push(message) },
      now: () => FIXED_NOW,
    })
    const deps: UsageCommandDeps = {
      tracker,
      billing,
      ...(store === undefined ? {} : { store }),
      ...(options.allocationCredits === undefined ? {} : { allocationCredits: options.allocationCredits }),
      resetDay: 1,
      now: () => FIXED_NOW,
    }
    const commands = commandDefinitions(auth, deps)
    return {
      tracker,
      store,
      commands,
      byName: (name) => {
        const found = commands.find((command) => command.name === name)
        if (found === undefined) throw new Error(`missing command ${name}`)
        return found
      },
    }
  }

  function record(h: Harness, nanoAiu: number, model = 'gpt-5.4'): void {
    const collector = h.tracker.startResponse()
    collector.addCall({ model, inputTokens: 1000, outputTokens: 100, nanoAiu, providerCallId: 'gh-req-1' })
    h.tracker.recordResponse(h.tracker.summarize(collector, model))
  }

  it('shows raw nano-AIU with an uncalibrated notice — never credits derived from it', async () => {
    const h = harness()
    record(h, 41_250_000)
    const result = await run(h.byName('copilot-usage'), '')
    expect(result.kind).toBe('success')
    if (result.kind !== 'success') return
    const text = result.text ?? ''
    expect(text).toContain('41,250,000 nano-AIU')
    expect(text).toContain('uncalibrated conversion')
    expect(text).toContain('Calibration: uncalibrated')
    // The billed-cost line must not present a credit figure.
    const billedLine = text.split('\n').find((line) => line.includes('CAPI copilot_usage'))
    expect(billedLine).toBeDefined()
    expect(billedLine).not.toMatch(/\d credits/)
  })

  it('shows the local estimate with its source and the ESTIMATED marker', async () => {
    const h = harness()
    record(h, 41_250_000)
    const result = await run(h.byName('copilot-usage'), '')
    if (result.kind !== 'success') throw new Error('expected success')
    expect(result.text).toContain('source: local-estimate')
    expect(result.text).toContain('ESTIMATED')
    expect(result.text).toContain('pricing table 2026-09-01')
  })

  it('hides the percentage until the allocation is explicitly configured', async () => {
    const unconfirmed = harness({ billing: true })
    record(unconfirmed, 41_250_000)
    const without = await run(unconfirmed.byName('copilot-usage'), '')
    if (without.kind !== 'success') throw new Error('expected success')
    expect(without.text).toContain('billed total (source: github-billing')
    expect(without.text).toContain('300 credits')
    expect(without.text).toContain('allocation: not confirmed')
    expect(without.text).not.toContain('% of configured')

    const confirmed = harness({ billing: true, allocationCredits: 1500 })
    record(confirmed, 41_250_000)
    const withAllocation = await run(confirmed.byName('copilot-usage'), '')
    if (withAllocation.kind !== 'success') throw new Error('expected success')
    expect(withAllocation.text).toContain('20% of configured 1,500 credits monthly allocation')
  })

  it('marks the reset date as approximate', async () => {
    const h = harness()
    const result = await run(h.byName('copilot-usage'), '')
    if (result.kind !== 'success') throw new Error('expected success')
    expect(result.text).toContain('reset date: 2026-10-01 (approximate)')
  })

  it('states the storage mode honestly in both configurations', async () => {
    const memory = await run(harness().byName('copilot-usage'), '')
    if (memory.kind !== 'success') throw new Error('expected success')
    expect(memory.text).toContain('Storage: disabled (opt-in)')
    expect(memory.text).toContain('current session')

    const persisted = await run(harness({ persisted: true }).byName('copilot-usage'), '')
    if (persisted.kind !== 'success') throw new Error('expected success')
    expect(persisted.text).toContain(storePath)
    expect(persisted.text).toContain('/copilot-usage-reset')
  })

  it('reports estimate-only mode and failure reasons when billing is unavailable', async () => {
    const noToken = await run(harness().byName('copilot-usage'), '')
    if (noToken.kind !== 'success') throw new Error('expected success')
    expect(noToken.text).toContain('estimate-only mode')

    const forbidden = harness({ billing: true, fetchFn: fakeFetch(403, '{}', { 'x-accepted-github-permissions': 'plan' }) })
    const result = await run(forbidden.byName('copilot-usage'), '')
    if (result.kind !== 'success') throw new Error('expected success')
    expect(result.text).toContain('billed total: unavailable')
    expect(result.text).toContain('Plan')
    expect(logs.some((message) => message.includes('plan'))).toBe(true)
    expect(logs.join('\n')).not.toContain(TOKEN)
  })

  it('calibrates only after explicit confirmation, with a non-default divisor, and persists it', async () => {
    const h = harness({ billing: true, persisted: true, fetchFn: fakeFetch(200, billingBody(300)) })
    record(h, 250_000_000) // local nano-AIU for 2026-09

    const proposal = await run(h.byName('copilot-usage-calibrate'), '')
    if (proposal.kind !== 'success') throw new Error('expected success')
    expect(proposal.text).toContain('Calibration proposal for 2026-09')
    expect(proposal.text).toContain('250,000,000')
    expect(proposal.text).toContain('300')
    expect(proposal.text).toContain('Not applied yet')
    expect(h.tracker.calibration().state).toBe('uncalibrated')

    const applied = await run(h.byName('copilot-usage-calibrate'), 'apply')
    if (applied.kind !== 'success') throw new Error('expected success')
    expect(applied.text).toContain('833,333')
    expect(applied.text).toContain('persisted')

    const calibration = h.tracker.calibration()
    expect(calibration.state).toBe('calibrated')
    // Persisted in the opt-in store.
    const persistedRaw = JSON.parse(readFileSync(storePath, 'utf8')) as { calibration: { state: string } }
    expect(persistedRaw.calibration.state).toBe('calibrated')

    // After calibration the report converts nano-AIU to credits with its source.
    const report = await run(h.byName('copilot-usage'), '')
    if (report.kind !== 'success') throw new Error('expected success')
    expect(report.text).toContain('300 credits')
    expect(report.text).toContain('calibrated')
  })

  it('refuses calibration without a billing token and stays estimate-only', async () => {
    const h = harness()
    record(h, 1_000_000)
    const result = await run(h.byName('copilot-usage-calibrate'), '')
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.text).toContain('estimate-only mode')
    expect(h.tracker.calibration().state).toBe('uncalibrated')
  })

  it('purges the opt-in store only after confirm', async () => {
    const h = harness({ persisted: true })
    record(h, 41_250_000)
    expect(existsSync(storePath)).toBe(true)

    const refused = await run(h.byName('copilot-usage-reset'), '')
    expect(refused.kind).toBe('error')
    expect(existsSync(storePath)).toBe(true)

    const confirmed = await run(h.byName('copilot-usage-reset'), 'confirm')
    expect(confirmed.kind).toBe('success')
    expect(existsSync(storePath)).toBe(false)
    expect(h.tracker.snapshot().responses).toBe(0)
    expect(h.tracker.calibration().state).toBe('uncalibrated')
  })

  it('says tracking is disabled when usageTracking is false', async () => {
    const h = harness({ enabled: false })
    const result = await run(h.byName('copilot-usage'), '')
    if (result.kind !== 'success') throw new Error('expected success')
    expect(result.text).toContain('disabled')
  })

  it('stays coherent between the local estimate and the billed report on simulated data', async () => {
    // 100K in + 100K out at GPT-5.4 default tier (below the 272K threshold) = 175 estimated credits.
    const h = harness({ billing: true, fetchFn: fakeFetch(200, billingBody(175)) })
    const collector = h.tracker.startResponse()
    collector.addCall({ model: 'gpt-5.4', inputTokens: 100_000, outputTokens: 100_000 })
    h.tracker.recordResponse(h.tracker.summarize(collector, 'gpt-5.4'))

    const month = h.tracker.month('2026-09')
    expect(month?.estimatedCredits).toBeCloseTo(175, 6)
    const comparison = estimateVsBilled(month?.estimatedCredits ?? 0, 175)
    expect(comparison.deltaCredits).toBeCloseTo(0, 6)
    expect(comparison.deltaPercent).toBeCloseTo(0, 6)

    const result = await run(h.byName('copilot-usage'), '')
    if (result.kind !== 'success') throw new Error('expected success')
    expect(result.text).toContain('175 credits')
    expect(result.text).toContain('source: github-billing')
    expect(result.text).toContain('source: local-estimate')
  })

  it('keeps the token out of every command output and log', async () => {
    const h = harness({ billing: true, fetchFn: fakeFetch(403, `{"leak":"${TOKEN}"}`, { 'x-accepted-github-permissions': 'plan' }) })
    record(h, 1000)
    const outputs = [
      await run(h.byName('copilot-usage'), ''),
      await run(h.byName('copilot-usage-calibrate'), ''),
    ]
    for (const output of outputs) expect(JSON.stringify(output)).not.toContain(TOKEN)
    expect(logs.join('\n')).not.toContain(TOKEN)
  })
})
