import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type { CopilotAuthController } from './auth.js'
import type { BillingReportClient, BillingResult } from './billing-report.js'
import { billedCreditsTotal } from './billing-report.js'
import { proposeCalibration, type CalibrationProposal } from './calibration.js'
import { safeErrorMessage } from './redaction.js'
import { formatUsageReport } from './usage-report.js'
import type { ConsumptionTracker } from './usage-tracker.js'
import type { UsageStore } from './usage-store.js'

function acceptsProvider(rawInput: string): boolean {
  const provider = rawInput.trim()
  return provider === 'github-copilot' || provider === 'github-copilot-sdk'
}

export interface UsageCommandDeps {
  readonly tracker: ConsumptionTracker
  readonly billing: BillingReportClient
  readonly store?: UsageStore
  /** Explicitly configured monthly allocation; undefined keeps percentages hidden. */
  readonly allocationCredits?: number
  /** Billing-cycle reset day (1-28), always displayed as approximate. */
  readonly resetDay: number
  readonly now?: () => Date
}

const PERIOD_PATTERN = /^\d{4}-\d{2}$/

function currentPeriod(now: Date): { year: number; month: number; key: string } {
  return {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    key: now.toISOString().slice(0, 7),
  }
}

export function commandDefinitions(auth: CopilotAuthController, usage?: UsageCommandDeps): readonly CommandDefinition[] {
  const commands: CommandDefinition[] = [
    {
      name: 'login',
      description: 'Log in to an LLM provider (github-copilot-sdk)',
      input: { hint: 'github-copilot-sdk' },
      handler: async ({ rawInput, signal }) => {
        if (!acceptsProvider(rawInput)) {
          return { kind: 'error', text: 'Usage: /login github-copilot-sdk' }
        }
        try {
          const notices: string[] = []
          const text = await auth.beginLogin(signal, {
            notify: (notice) => notices.push(notice.message),
            prompt: async () => {
              throw new AuthorizationDeclinedError('The official Copilot browser flow does not accept text input in DSH')
            },
          })
          return { kind: 'success', text: [...notices, text].join('\n') }
        } catch (error) {
          return { kind: 'error', text: safeErrorMessage(error) }
        }
      },
    },
    {
      name: 'logout',
      description: 'Log out from an LLM provider (github-copilot-sdk)',
      input: { hint: 'github-copilot-sdk' },
      handler: async ({ rawInput, signal }) => {
        if (!acceptsProvider(rawInput)) {
          return { kind: 'error', text: 'Usage: /logout github-copilot-sdk' }
        }
        try {
          return { kind: 'success', text: await auth.logout(signal) }
        } catch (error) {
          return { kind: 'error', text: safeErrorMessage(error) }
        }
      },
    },
    {
      name: 'copilot-status',
      description: 'Refresh and show the non-secret GitHub Copilot authentication state',
      handler: async () => {
        const state = await auth.refreshState()
        const account = state.login === undefined ? '' : ` (${state.login})`
        return state.phase === 'refresh-succeeded'
          ? { kind: 'success', text: `GitHub Copilot is connected${account}.` }
          : { kind: 'error', text: `GitHub Copilot state: ${state.phase}${state.message === undefined ? '' : ` — ${state.message}`}` }
      },
    },
  ]

  if (usage !== undefined) commands.push(...usageCommands(auth, usage))
  return commands
}

function usageCommands(auth: CopilotAuthController, deps: UsageCommandDeps): readonly CommandDefinition[] {
  const now = deps.now ?? (() => new Date())
  /** Last computed calibration proposal; `apply` only ever applies this one. */
  let pendingProposal: CalibrationProposal | undefined

  const resolveLogin = async (): Promise<string | undefined> => {
    const state = await auth.refreshState()
    return state.login
  }

  const calibrate: CommandDefinition = {
    name: 'copilot-usage-calibrate',
    description: 'Calibrate the nano-AIU → AI credit divisor against the official billing report',
    input: { hint: '[YYYY-MM | apply]' },
    handler: async ({ rawInput }) => {
      const arg = rawInput.trim()
      if (arg === 'apply') {
        const proposal = pendingProposal
        if (proposal === undefined) {
          return { kind: 'error', text: 'No pending calibration proposal. Run /copilot-usage-calibrate first.' }
        }
        deps.tracker.applyCalibration({
          state: 'calibrated',
          nanoAiuPerCredit: proposal.measuredNanoAiuPerCredit,
          calibratedAt: now().toISOString(),
          period: proposal.period,
          localNanoAiu: proposal.localNanoAiu,
          billedCredits: proposal.billedCredits,
        })
        pendingProposal = undefined
        const scope = deps.store !== undefined ? ' and persisted' : ' for this session only (enable usagePersist to keep it)'
        return {
          kind: 'success',
          text: `Calibration applied${scope}: 1 AI credit = ${proposal.measuredNanoAiuPerCredit.toLocaleString('en-US')} nano-AIU.`,
        }
      }
      if (arg !== '' && !PERIOD_PATTERN.test(arg)) {
        return { kind: 'error', text: 'Usage: /copilot-usage-calibrate [YYYY-MM | apply]' }
      }
      if (!deps.billing.configured) {
        return {
          kind: 'error',
          text: 'Calibration needs the official billing report, which needs a billing token (billingTokenPath). Without it the plugin stays in estimate-only mode.',
        }
      }
      const periodKey = PERIOD_PATTERN.test(arg) ? arg : currentPeriod(now()).key
      const login = await resolveLogin()
      if (login === undefined) return { kind: 'error', text: 'Not logged in: cannot resolve the GitHub username.' }
      const [year, month] = periodKey.split('-').map(Number)
      if (year === undefined || month === undefined) return { kind: 'error', text: `Invalid period "${periodKey}".` }
      const billing = await deps.billing.report(login, { year, month })
      if (!billing.ok) return { kind: 'error', text: `Billing report unavailable: ${billing.message}` }
      const localNanoAiu = deps.tracker.monthNanoAiu(periodKey)
      const billedCredits = billedCreditsTotal(billing.report)
      const result = proposeCalibration(periodKey, localNanoAiu, billedCredits)
      if (!result.ok) {
        const messages = {
          'no-local-data': `No locally observed nano-AIU for ${periodKey}. Use the Copilot route, then retry.`,
          'no-billed-usage': `The billing report shows 0 credits for ${periodKey}; nothing to calibrate against.`,
          'invalid-billed-value': 'The billing report carried an invalid quantity.',
        } as const
        return { kind: 'error', text: messages[result.reason] }
      }
      pendingProposal = result.proposal
      const p = result.proposal
      const lines = [
        `Calibration proposal for ${p.period}:`,
        `  local nano-AIU total (CAPI copilot_usage): ${p.localNanoAiu.toLocaleString('en-US')}`,
        `  billed credits (source: github-billing, fetched ${billing.fetchedAt}): ${p.billedCredits.toLocaleString('en-US')}`,
        `  measured divisor: 1 credit = ${p.measuredNanoAiuPerCredit.toLocaleString('en-US')} nano-AIU (default assumption: ${p.defaultNanoAiuPerCredit.toLocaleString('en-US')})`,
      ]
      if (!p.plausible) {
        lines.push(
          '  warning: the measured divisor is far from 1e9; local and billed periods may not overlap exactly (billing lag).',
        )
      }
      lines.push('Not applied yet. Run /copilot-usage-calibrate apply to confirm.')
      return { kind: 'success', text: lines.join('\n') }
    },
  }

  const report: CommandDefinition = {
    name: 'copilot-usage',
    description: 'Show GitHub Copilot consumption: last response, month totals, billed vs estimated',
    input: { hint: '[refresh]' },
    handler: async ({ rawInput }) => {
      const force = rawInput.trim() === 'refresh'
      const period = currentPeriod(now())
      let billing: BillingResult | undefined
      if (deps.billing.configured) {
        const login = await resolveLogin()
        if (login === undefined) {
          billing = {
            ok: false,
            reason: 'no-token-configured',
            message: 'Not logged in: cannot resolve the GitHub username for the billing report.',
          }
        } else {
          billing = await deps.billing.report(login, period, { force })
        }
      }
      const text = formatUsageReport({
        snapshot: deps.tracker.snapshot(),
        month: deps.tracker.month(period.key),
        monthKey: period.key,
        billing,
        calibration: deps.tracker.calibration(),
        allocation: deps.allocationCredits === undefined ? {} : { credits: deps.allocationCredits },
        resetDay: deps.resetDay,
        storePath: deps.store?.path,
        now: now(),
      })
      return { kind: 'success', text }
    },
  }

  const reset: CommandDefinition = {
    name: 'copilot-usage-reset',
    description: 'Purge locally stored Copilot consumption statistics (opt-in storage)',
    input: { hint: 'confirm' },
    handler: async ({ rawInput }) => {
      if (rawInput.trim() !== 'confirm') {
        const target =
          deps.store === undefined ? 'in-memory session aggregates' : `the store file ${deps.store.path} and in-memory aggregates`
        return {
          kind: 'error',
          text: `This deletes ${target}, including calibration. Run /copilot-usage-reset confirm to proceed.`,
        }
      }
      const removed = deps.store?.purge() ?? false
      deps.tracker.resetAggregates()
      pendingProposal = undefined
      return {
        kind: 'success',
        text: removed
          ? `Deleted ${deps.store?.path ?? ''} and cleared in-memory aggregates (including calibration).`
          : 'Cleared in-memory aggregates (including calibration); no store file existed.',
      }
    },
  }

  return [report, calibrate, reset]
}
