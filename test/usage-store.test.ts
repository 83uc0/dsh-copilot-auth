import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UNCALIBRATED } from '../src/calibration.js'
import { UsageStore, defaultStorePath, parseStoreData } from '../src/usage-store.js'
import { ConsumptionTracker } from '../src/usage-tracker.js'

const FIXED_NOW = new Date('2026-09-10T12:00:00.000Z')

describe('UsageStore', () => {
  let dir: string
  let path: string
  let logs: string[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'copilot-usage-store-'))
    path = join(dir, 'usage.json')
    logs = []
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const store = (): UsageStore => new UsageStore(path, { info: (message) => logs.push(message) })

  it('creates the store file with 0600 permissions', () => {
    store().save({ version: 1, updatedAt: FIXED_NOW.toISOString(), calibration: UNCALIBRATED, months: {} })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(existsSync(path)).toBe(true)
  })

  it('repairs too-wide permissions on load and logs the repair', () => {
    store().save({ version: 1, updatedAt: FIXED_NOW.toISOString(), calibration: UNCALIBRATED, months: {} })
    chmodSync(path, 0o644)
    const data = store().load()
    expect(data).toBeDefined()
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(logs.some((message) => message.includes('repaired to 600'))).toBe(true)
  })

  it('degrades a corrupt file to an empty load instead of crashing', () => {
    writeFileSync(path, 'not json {', { mode: 0o600 })
    expect(store().load()).toBeUndefined()
    expect(logs.some((message) => message.includes('starting empty'))).toBe(true)
  })

  it('parses only the documented shape and drops unknown months', () => {
    const parsed = parseStoreData(
      {
        version: 1,
        updatedAt: 'x',
        calibration: { state: 'uncalibrated' },
        months: {
          '2026-09': { responses: 2, modelCalls: 3, nanoAiuTotal: 5, estimatedCredits: 1, estimatedUsd: 0.01, perModel: {} },
          garbage: { responses: 99 },
        },
      },
      'now',
    )
    expect(Object.keys(parsed.months)).toEqual(['2026-09'])
    expect(parsed.months['2026-09']?.responses).toBe(2)
    expect(parseStoreData('junk', 'now').months).toEqual({})
  })

  it('purges the store file', () => {
    const s = store()
    expect(s.purge()).toBe(false)
    s.save({ version: 1, updatedAt: FIXED_NOW.toISOString(), calibration: UNCALIBRATED, months: {} })
    expect(s.purge()).toBe(true)
    expect(existsSync(path)).toBe(false)
  })

  it('persists and rehydrates monthly aggregates through the tracker', () => {
    const now = () => FIXED_NOW
    const tracker = new ConsumptionTracker({ now })
    const s = store()
    tracker.attachStore(s)

    const collector = tracker.startResponse()
    collector.addCall({ model: 'gpt-5.4', inputTokens: 1000, outputTokens: 100, nanoAiu: 41_250_000 })
    tracker.recordResponse(tracker.summarize(collector, 'gpt-5.4'))

    const raw = JSON.parse(readFileSync(path, 'utf8')) as { months: Record<string, { nanoAiuTotal: number }> }
    expect(raw.months['2026-09']?.nanoAiuTotal).toBe(41_250_000)
    // Counters only: no prompt, no content, no messages in the persisted file.
    const text = readFileSync(path, 'utf8')
    expect(text).not.toContain('prompt')
    expect(text).not.toContain('Hello')

    const restored = new ConsumptionTracker({ now })
    const data = store().load()
    expect(data).toBeDefined()
    if (data !== undefined) restored.hydrate(data)
    const month = restored.month('2026-09')
    expect(month?.nanoAiuTotal).toBe(41_250_000)
    expect(month?.perModel[0]).toMatchObject({ model: 'gpt-5.4', inputTokens: 1000, outputTokens: 100 })
  })

  it('defaults to the user state directory, never the repository', () => {
    const path_ = defaultStorePath({})
    expect(path_).toContain('.local/state')
    expect(path_).not.toContain('dsh-plugins-private')
  })
})
