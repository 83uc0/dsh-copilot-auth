/**
 * nano-AIU → AI-credit conversion state.
 *
 * The CAPI `copilot_usage.totalNanoAiu` field is a RAW provider quantity.
 * The divisor that turns it into AI credits is NOT documented publicly, so
 * this plugin never presents a nano-AIU-derived credit or USD figure until
 * the user has calibrated it against the official billing endpoint
 * (`/copilot-usage-calibrate`). Until then the raw nano-AIU value is shown
 * with an explicit "conversion non calibrée" notice.
 */

/**
 * Default divisor, matching the "nano" prefix: 1 AI credit = 1e9 nano-AIU.
 * UNCALIBRATED — used only after the user confirms a measured value.
 */
export const NANO_AIU_PER_CREDIT = 1e9

export type CalibrationState =
  | { readonly state: 'uncalibrated' }
  | {
      readonly state: 'calibrated'
      readonly nanoAiuPerCredit: number
      readonly calibratedAt: string
      /** Billing period the calibration compared, e.g. "2026-09". */
      readonly period: string
      readonly localNanoAiu: number
      readonly billedCredits: number
    }

export const UNCALIBRATED: CalibrationState = { state: 'uncalibrated' }

/**
 * Convert raw nano-AIU to credits, or return undefined while uncalibrated.
 * Callers must treat undefined as "display the raw value, no credit figure".
 */
export function nanoAiuToCredits(nanoAiu: number, calibration: CalibrationState): number | undefined {
  if (calibration.state !== 'calibrated') return undefined
  return nanoAiu / calibration.nanoAiuPerCredit
}

export interface CalibrationProposal {
  readonly period: string
  readonly localNanoAiu: number
  readonly billedCredits: number
  readonly measuredNanoAiuPerCredit: number
  readonly defaultNanoAiuPerCredit: number
  /** False when the measured divisor is suspiciously far from 1e9. */
  readonly plausible: boolean
}

export type CalibrationProposalResult =
  | { readonly ok: true; readonly proposal: CalibrationProposal }
  | { readonly ok: false; readonly reason: 'no-local-data' | 'no-billed-usage' | 'invalid-billed-value' }

/** Compare a local nano-AIU sum to the billed credits of the same period. */
export function proposeCalibration(
  period: string,
  localNanoAiu: number,
  billedCredits: number,
): CalibrationProposalResult {
  if (localNanoAiu <= 0) return { ok: false, reason: 'no-local-data' }
  if (billedCredits < 0 || Number.isNaN(billedCredits)) return { ok: false, reason: 'invalid-billed-value' }
  if (billedCredits === 0) return { ok: false, reason: 'no-billed-usage' }
  const measured = localNanoAiu / billedCredits
  const plausible = measured > NANO_AIU_PER_CREDIT / 100 && measured < NANO_AIU_PER_CREDIT * 100
  return {
    ok: true,
    proposal: {
      period,
      localNanoAiu,
      billedCredits,
      measuredNanoAiuPerCredit: measured,
      defaultNanoAiuPerCredit: NANO_AIU_PER_CREDIT,
      plausible,
    },
  }
}

/** Parse persisted calibration data; anything unexpected degrades to uncalibrated. */
export function parseCalibrationState(value: unknown): CalibrationState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return UNCALIBRATED
  const record = value as Record<string, unknown>
  if (record.state !== 'calibrated') return UNCALIBRATED
  if (typeof record.nanoAiuPerCredit !== 'number' || !(record.nanoAiuPerCredit > 0)) return UNCALIBRATED
  if (typeof record.calibratedAt !== 'string' || typeof record.period !== 'string') return UNCALIBRATED
  if (typeof record.localNanoAiu !== 'number' || typeof record.billedCredits !== 'number') return UNCALIBRATED
  return {
    state: 'calibrated',
    nanoAiuPerCredit: record.nanoAiuPerCredit,
    calibratedAt: record.calibratedAt,
    period: record.period,
    localNanoAiu: record.localNanoAiu,
    billedCredits: record.billedCredits,
  }
}
