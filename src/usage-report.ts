/**
 * Text rendering for the /copilot-usage family of commands.
 *
 * Display rules baked in here (do not bypass):
 * - every amount carries its source: 'github-billed' (CAPI nano-AIU or the
 *   billing endpoint) or 'local-estimate' (dated pricing table);
 * - nano-AIU is rendered RAW with "uncalibrated conversion" until the user
 *   has calibrated the divisor — never as credits or USD;
 * - a monthly percentage is shown ONLY when the allocation was explicitly
 *   configured; the built-in Pro default is reported without a percentage;
 * - the reset date is always marked as approximate.
 */

import { nanoAiuToCredits, type CalibrationState } from './calibration.js'
import type { BillingReport, BillingResult } from './billing-report.js'
import { billedCreditsByModel, billedCreditsTotal } from './billing-report.js'
import type { ConsumptionSnapshot, MonthSnapshot, ResponseUsageSummary } from './usage-tracker.js'

export interface AllocationConfig {
  /** Explicitly configured monthly allocation; undefined means unconfirmed. */
  readonly credits?: number
}

/** Default monthly allocation of a personal Copilot Pro plan — an assumption, not a measurement. */
export const DEFAULT_PRO_ALLOCATION_CREDITS = 1500

export interface UsageReportInput {
  readonly snapshot: ConsumptionSnapshot
  readonly month: MonthSnapshot | undefined
  readonly monthKey: string
  readonly billing: BillingResult | undefined
  readonly calibration: CalibrationState
  readonly allocation: AllocationConfig
  /** Day of month the billing cycle resets (approximate). */
  readonly resetDay: number
  readonly storePath: string | undefined
  readonly now: Date
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function fmtCredits(value: number): string {
  return `${round(value, value < 10 ? 4 : 2).toLocaleString('en-US')} credits`
}

function fmtUsd(value: number): string {
  return `$${round(value, value < 1 ? 4 : 2).toLocaleString('en-US')}`
}

function fmtTokens(value: number): string {
  return value.toLocaleString('en-US')
}

/** Approximate reset date: `resetDay` of the next month, always labelled approximate. */
export function approximateResetDate(now: Date, resetDay: number): string {
  const day = Math.min(Math.max(Math.trunc(resetDay), 1), 28)
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, day))
  return `${reset.toISOString().slice(0, 10)} (approximate)`
}

/** Per-response block: the full model list, never collapsed to one model. */
export function formatLastResponse(summary: ResponseUsageSummary | undefined, calibration: CalibrationState): string[] {
  if (summary === undefined) return ['Last response: none recorded yet.']
  const lines: string[] = []
  lines.push(`Last response (${summary.at}):`)
  lines.push(`  requested model: ${summary.requestedModel}`)
  if (summary.calls.length === 0) {
    lines.push('  no usage reported by the SDK for this response (no token counts invented)')
  }
  for (const call of summary.calls) {
    const parts: string[] = [`model ${call.model}`]
    if (call.inputTokens !== undefined) parts.push(`in ${fmtTokens(call.inputTokens)}`)
    if (call.cacheReadTokens !== undefined) parts.push(`cached ${fmtTokens(call.cacheReadTokens)}`)
    if (call.cacheWriteTokens !== undefined) parts.push(`cache-write ${fmtTokens(call.cacheWriteTokens)}`)
    if (call.outputTokens !== undefined) parts.push(`out ${fmtTokens(call.outputTokens)}`)
    if (call.durationMs !== undefined) parts.push(`${String(call.durationMs)} ms`)
    if (call.timeToFirstTokenMs !== undefined) parts.push(`ttft ${String(call.timeToFirstTokenMs)} ms`)
    if (call.providerCallId !== undefined) parts.push(`req ${call.providerCallId}`)
    else if (call.apiCallId !== undefined) parts.push(`req ${call.apiCallId}`)
    lines.push(`  - ${parts.join(', ')}`)
  }
  for (const change of summary.modelChanges) {
    const cause = change.cause === undefined ? '' : ` (cause: ${change.cause})`
    lines.push(`  model change: ${change.previousModel ?? '?'} → ${change.newModel}${cause}`)
  }
  // Source hierarchy: 1) billed per-request nano-AIU, 2) local estimate, 3) nothing.
  if (summary.nanoAiuTotal !== undefined) {
    const credits = nanoAiuToCredits(summary.nanoAiuTotal, calibration)
    if (credits === undefined) {
      lines.push(
        `  billed cost (source: CAPI copilot_usage): ${fmtTokens(summary.nanoAiuTotal)} nano-AIU — uncalibrated conversion, no credit/USD figure shown`,
      )
    } else {
      lines.push(
        `  billed cost (source: CAPI copilot_usage, calibrated): ${fmtCredits(credits)} ≈ ${fmtUsd(credits * 0.01)}`,
      )
    }
  }
  if (summary.estimate !== undefined) {
    const estimate = summary.estimate
    lines.push(
      `  estimated cost (source: local-estimate, pricing table ${estimate.pricingTableRetrievedAt}): ${fmtCredits(estimate.totalCredits)} ≈ ${fmtUsd(estimate.totalUsd)} — ESTIMATED`,
    )
    for (const entry of estimate.perModel) {
      lines.push(
        `    ${entry.model}: ${entry.calls} call(s), ${fmtCredits(entry.estimate.credits)} (${entry.estimate.tier} tier${entry.estimate.partial ? ', partial token data' : ''})`,
      )
    }
    for (const model of estimate.unknownModels) lines.push(`    ${model}: unknown pricing — no cost estimated`)
    for (const model of estimate.uncountedModels) lines.push(`    ${model}: no token counts reported`)
  }
  if (summary.nanoAiuTotal === undefined && summary.estimate === undefined) {
    lines.push('  cost: unavailable (no billed usage and no token counts reported)')
  }
  return lines
}

/** Month block combining local aggregates and the optional billed report. */
export function formatMonth(input: UsageReportInput): string[] {
  const lines: string[] = []
  const { month, monthKey } = input
  lines.push(`Current month (${monthKey}):`)
  if (month === undefined || month.modelCalls === 0) {
    lines.push('  no local usage recorded this month')
  } else {
    lines.push(`  local tracking: ${month.responses} response(s), ${month.modelCalls} model call(s)`)
    for (const aggregate of month.perModel) {
      const parts: string[] = [
        `${aggregate.model}: ${aggregate.calls} call(s)`,
        `in ${fmtTokens(aggregate.inputTokens)}`,
        `out ${fmtTokens(aggregate.outputTokens)}`,
      ]
      if (aggregate.cacheReadTokens > 0) parts.push(`cached ${fmtTokens(aggregate.cacheReadTokens)}`)
      lines.push(`    ${parts.join(', ')}`)
      if (aggregate.nanoAiu > 0) {
        const credits = nanoAiuToCredits(aggregate.nanoAiu, input.calibration)
        lines.push(
          credits === undefined
            ? `      billed: ${fmtTokens(aggregate.nanoAiu)} nano-AIU — uncalibrated conversion`
            : `      billed: ${fmtCredits(credits)} (source: CAPI copilot_usage, calibrated)`,
        )
      }
      if (aggregate.tableKnown && aggregate.estimatedCredits > 0) {
        lines.push(`      estimated: ${fmtCredits(aggregate.estimatedCredits)} ≈ ${fmtUsd(aggregate.estimatedUsd)} (source: local-estimate) — ESTIMATED`)
      } else if (!aggregate.tableKnown) {
        lines.push('      estimated: unknown pricing — no cost estimated')
      }
    }
    lines.push(
      `  local estimate total: ${fmtCredits(month.estimatedCredits)} ≈ ${fmtUsd(month.estimatedUsd)} (source: local-estimate) — ESTIMATED`,
    )
  }

  if (input.billing !== undefined && input.billing.ok) {
    const report: BillingReport = input.billing.report
    const total = billedCreditsTotal(report)
    lines.push(
      `  billed total (source: github-billing, fetched ${input.billing.fetchedAt}${input.billing.fromCache ? ', cached' : ''}): ${fmtCredits(total)} ≈ ${fmtUsd(total * 0.01)}`,
    )
    for (const [model, credits] of billedCreditsByModel(report)) {
      if (credits > 0) lines.push(`    ${model}: ${fmtCredits(credits)} (billed)`)
    }
    if (report.usageItems.length === 0) lines.push('    (billing report contains no usage items for this period)')
    // Percentage ONLY when the allocation was explicitly configured.
    if (input.allocation.credits !== undefined && input.allocation.credits > 0) {
      const percent = round((total / input.allocation.credits) * 100, 1)
      lines.push(`  allocation: ${String(percent)}% of configured ${fmtCredits(input.allocation.credits)} monthly allocation`)
    }
  } else if (input.billing !== undefined && !input.billing.ok) {
    lines.push(`  billed total: unavailable — ${input.billing.message}`)
  } else {
    lines.push('  billed total: not fetched (no billing token configured — estimate-only mode)')
  }

  if (input.allocation.credits === undefined) {
    lines.push(
      `  allocation: not confirmed (Copilot Pro default would be ${fmtCredits(DEFAULT_PRO_ALLOCATION_CREDITS)}); set billingAllocationCredits to display a percentage`,
    )
  }
  lines.push(`  reset date: ${approximateResetDate(input.now, input.resetDay)} — approximate, overridable via billingResetDay`)
  return lines
}

/** Full /copilot-usage report. */
export function formatUsageReport(input: UsageReportInput): string {
  const { snapshot } = input
  const lines: string[] = ['GitHub Copilot consumption']
  if (!snapshot.enabled) {
    lines.push('Usage tracking is disabled (usageTracking: false).')
    return lines.join('\n')
  }
  lines.push('')
  lines.push(...formatLastResponse(snapshot.recentResponses.at(-1), input.calibration))
  lines.push('')
  lines.push(...formatMonth(input))
  lines.push('')
  if (input.calibration.state === 'calibrated') {
    lines.push(
      `Calibration: 1 credit = ${input.calibration.nanoAiuPerCredit.toLocaleString('en-US')} nano-AIU (measured ${input.calibration.calibratedAt.slice(0, 10)} on period ${input.calibration.period})`,
    )
  } else {
    lines.push('Calibration: uncalibrated — nano-AIU amounts are raw; run /copilot-usage-calibrate to convert them.')
  }
  lines.push(
    input.storePath === undefined
      ? 'Storage: disabled (opt-in). This report covers the current session plus any fetched billing data; monthly history requires usagePersist: true.'
      : `Storage: ${input.storePath} (counters only — no prompts or content; purge with /copilot-usage-reset)`,
  )
  lines.push(
    `Session: ${snapshot.responses} response(s) since ${snapshot.startedAt}, ${snapshot.responsesWithoutUsage} without SDK usage data, convention: ${snapshot.convention} (${snapshot.conventionSource})`,
  )
  if (snapshot.isolationErrors > 0) {
    lines.push(
      `Tracking errors isolated: ${String(snapshot.isolationErrors)}${snapshot.lastError === undefined ? '' : ` — last: ${snapshot.lastError}`}`,
    )
  }
  return lines.join('\n')
}

/** Estimation vs billed coherence check on a period (used by calibration tests and reports). */
export function estimateVsBilled(
  estimatedCredits: number,
  billedCredits: number,
): { readonly deltaCredits: number; readonly deltaPercent: number | undefined } {
  const deltaCredits = billedCredits - estimatedCredits
  return {
    deltaCredits,
    deltaPercent: estimatedCredits > 0 ? (deltaCredits / estimatedCredits) * 100 : undefined,
  }
}
