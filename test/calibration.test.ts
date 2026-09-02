import { describe, expect, it } from 'vitest'
import {
  NANO_AIU_PER_CREDIT,
  UNCALIBRATED,
  nanoAiuToCredits,
  parseCalibrationState,
  proposeCalibration,
} from '../src/calibration.js'

describe('calibration state', () => {
  it('never converts nano-AIU to credits while uncalibrated', () => {
    expect(NANO_AIU_PER_CREDIT).toBe(1e9)
    expect(nanoAiuToCredits(5e8, UNCALIBRATED)).toBeUndefined()
  })

  it('converts with the measured divisor once calibrated', () => {
    const state = {
      state: 'calibrated' as const,
      nanoAiuPerCredit: 5e8,
      calibratedAt: '2026-09-01T10:00:00.000Z',
      period: '2026-09',
      localNanoAiu: 5e8,
      billedCredits: 1,
    }
    expect(nanoAiuToCredits(5e8, state)).toBe(1)
    expect(nanoAiuToCredits(250_000_000, state)).toBe(0.5)
  })

  it('proposes a divisor different from 1e9 when the measurement says so', () => {
    const result = proposeCalibration('2026-09', 250_000_000, 300)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.proposal.measuredNanoAiuPerCredit).toBeCloseTo(833_333.33, 0)
    expect(result.proposal.defaultNanoAiuPerCredit).toBe(1e9)
    // 8.3e5 is far outside the plausibility band around 1e9.
    expect(result.proposal.plausible).toBe(false)
  })

  it('accepts a plausible measurement near 1e9', () => {
    const result = proposeCalibration('2026-09', 3e9, 3)
    expect(result.ok && result.proposal.plausible).toBe(true)
    if (result.ok) expect(result.proposal.measuredNanoAiuPerCredit).toBe(1e9)
  })

  it('refuses to calibrate without local data or without billed usage', () => {
    expect(proposeCalibration('2026-09', 0, 300)).toMatchObject({ ok: false, reason: 'no-local-data' })
    expect(proposeCalibration('2026-09', 1e9, 0)).toMatchObject({ ok: false, reason: 'no-billed-usage' })
    expect(proposeCalibration('2026-09', 1e9, Number.NaN)).toMatchObject({ ok: false, reason: 'invalid-billed-value' })
  })

  it('degrades corrupt persisted calibration to uncalibrated', () => {
    expect(parseCalibrationState(undefined)).toEqual(UNCALIBRATED)
    expect(parseCalibrationState({ state: 'calibrated' })).toEqual(UNCALIBRATED)
    expect(parseCalibrationState({ state: 'calibrated', nanoAiuPerCredit: -5 })).toEqual(UNCALIBRATED)
    const valid = {
      state: 'calibrated',
      nanoAiuPerCredit: 5e8,
      calibratedAt: '2026-09-01T10:00:00.000Z',
      period: '2026-09',
      localNanoAiu: 5e8,
      billedCredits: 1,
    }
    expect(parseCalibrationState(valid)).toEqual(valid)
  })
})
