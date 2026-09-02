import { describe, expect, it, vi } from 'vitest'
import { clientUsageSnapshot } from '../src/index.js'
import { UsageController } from '../src/client-controller.js'
import { ConsumptionTracker } from '../src/usage-tracker.js'

function tracker(enabled = true): ConsumptionTracker {
  return new ConsumptionTracker({ enabled })
}

function record(target: ConsumptionTracker, model = 'gpt-5.4', nanoAiu?: number): void {
  const collector = target.startResponse()
  collector.addText('answer')
  collector.addCall({ model, inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 3, outputTokens: 40, durationMs: 80, timeToFirstTokenMs: 10, ...(nanoAiu === undefined ? {} : { nanoAiu }) })
  target.recordResponse(target.summarize(collector, 'auto'))
}

describe('client usage snapshot', () => {
  it('returns empty state', () => {
    expect(clientUsageSnapshot(tracker(), undefined, false)).toMatchObject({ schemaVersion: 1, response: null, month: null, billing: 'not-configured' })
  })

  it('returns explicit and resolved models with measured fields', () => {
    const target = tracker()
    record(target, 'claude-sonnet-4.5', 123)
    expect(clientUsageSnapshot(target, 1500, true)).toMatchObject({ response: { requestedModel: 'auto', model: 'claude-sonnet-4.5', text: 'answer', status: 'UNCALIBRATED', nanoAiu: 123 }, allocationCredits: 1500 })
  })

  it('marks local cost estimate and keeps tracking disabled explicit', () => {
    const target = tracker(false)
    expect(clientUsageSnapshot(target, undefined, false)).toMatchObject({ enabled: false, response: null })
    const enabled = tracker()
    record(enabled)
    expect(clientUsageSnapshot(enabled, undefined, false)).toMatchObject({ response: { status: 'ESTIMATED' } })
  })

  it('keeps previous value on fetch failure and refreshes on polling', async () => {
    const controller = new UsageController()
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ value: 1 }) })
      .mockRejectedValueOnce(new Error('offline'))
    await controller.poll(fetchFn as typeof fetch)
    await controller.poll(fetchFn as typeof fetch)
    expect(controller.state.snapshot).toEqual({ value: 1 })
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})