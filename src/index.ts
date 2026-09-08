import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-authorization'
import '@deepseek-ai/dsh-commands'
import '@deepseek-ai/dsh-credentials'
import '@deepseek-ai/dsh-llm'
import { GitHubCopilotAdapter, PROVIDER } from './adapter.js'
import { CopilotAuthController } from './auth.js'
import { BillingReportClient } from './billing-report.js'
import { commandDefinitions } from './commands.js'
import { CopilotCliLoginRunner, CopilotRuntimeManager, OfficialCopilotRuntime } from './copilot-runtime.js'
import { UsageStore, defaultStorePath } from './usage-store.js'
import { ConsumptionTracker, type InputConventionConfig } from './usage-tracker.js'

export const name = 'llm-github-copilot'
export const inject = ['llm', 'credentials', 'commands']
const USAGE_ROUTE = '/github-copilot/usage'

function sendJson(res: { writeHead(status: number, headers: Record<string, string>): void; end(body: string): void }, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}

export function clientUsageSnapshot(
  tracker: ConsumptionTracker,
  allocationCredits: number | undefined,
  billingConfigured: boolean,
  now = new Date(),
): Record<string, unknown> {
  const snapshot = tracker.snapshot()
  const period = now.toISOString().slice(0, 7)
  const last = snapshot.recentResponses.at(-1)
  const response = last === undefined ? null : {
    at: last.at,
    requestedModel: last.requestedModel,
    ...(last.responseText === undefined ? {} : { text: last.responseText }),
    model: last.calls.at(-1)?.model,
    calls: last.calls.map((call) => ({
      model: call.model,
      ...(call.inputTokens === undefined ? {} : { inputTokens: call.inputTokens }),
      ...(call.cacheReadTokens === undefined ? {} : { cachedTokens: call.cacheReadTokens }),
      ...(call.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: call.cacheWriteTokens }),
      ...(call.outputTokens === undefined ? {} : { outputTokens: call.outputTokens }),
      ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
      ...(call.timeToFirstTokenMs === undefined ? {} : { ttftMs: call.timeToFirstTokenMs }),
    })),
    ...(last.nanoAiuTotal === undefined ? {} : { nanoAiu: last.nanoAiuTotal }),
    ...(last.estimate === undefined ? {} : { estimatedCredits: last.estimate.totalCredits, estimatedUsd: last.estimate.totalUsd }),
    status: last.nanoAiuTotal !== undefined && snapshot.calibration.state !== 'calibrated' ? 'UNCALIBRATED' : last.estimate === undefined ? 'UNCALIBRATED' : 'ESTIMATED',
  }
  const month = tracker.month(period)
  return {
    schemaVersion: 1,
    enabled: snapshot.enabled,
    response,
    session: { responses: snapshot.responses, modelCalls: snapshot.modelCalls, nanoAiu: snapshot.nanoAiuTotal, estimatedCredits: snapshot.estimatedCredits, estimatedUsd: snapshot.estimatedUsd },
    month: month === undefined ? null : { responses: month.responses, modelCalls: month.modelCalls, nanoAiu: month.nanoAiuTotal, estimatedCredits: month.estimatedCredits, estimatedUsd: month.estimatedUsd },
    ...(allocationCredits === undefined ? {} : { allocationCredits, allocationPercent: month === undefined ? 0 : (month.estimatedCredits / allocationCredits) * 100 }),
    calibration: snapshot.calibration.state,
    billing: billingConfigured ? 'unavailable' : 'not-configured',
    fetchedAt: now.toISOString(),
  }
}

export interface PluginConfig {
  /** Master switch: false disables every consumption-tracking feature. Default true. */
  readonly usageTracking?: boolean
  /**
   * Token input convention: 'auto' observes real events (default), the other
   * values force the convention when the provider's semantics are known.
   */
  readonly tokenInputConvention?: InputConventionConfig
  /** Opt-in local persistence of consumption counters (never prompts/content). Default false. */
  readonly usagePersist?: boolean
  /** Store file location; defaults to the user state directory, never the repo. */
  readonly usageStorePath?: string
  /** Path to a 0600 file holding ONLY the fine-grained billing PAT (user "Plan" read). */
  readonly billingTokenPath?: string
  /** Billing report cache TTL in minutes; values below the enforced minimum are clamped. */
  readonly billingRefreshMinutes?: number
  /** Monthly AI-credit allocation; only an explicit value unlocks the percentage display. */
  readonly billingAllocationCredits?: number
  /** Billing-cycle reset day (1-28), always displayed as approximate. Default 1. */
  readonly billingResetDay?: number
}

function parseConfig(raw: unknown): PluginConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const record = raw as Record<string, unknown>
  const convention = record.tokenInputConvention
  const resetDay = record.billingResetDay
  return {
    ...(typeof record.usageTracking === 'boolean' ? { usageTracking: record.usageTracking } : {}),
    ...(convention === 'auto' || convention === 'disjoint' || convention === 'inclusive'
      ? { tokenInputConvention: convention }
      : {}),
    ...(typeof record.usagePersist === 'boolean' ? { usagePersist: record.usagePersist } : {}),
    ...(typeof record.usageStorePath === 'string' && record.usageStorePath !== ''
      ? { usageStorePath: record.usageStorePath }
      : {}),
    ...(typeof record.billingTokenPath === 'string' && record.billingTokenPath !== ''
      ? { billingTokenPath: record.billingTokenPath }
      : {}),
    ...(typeof record.billingRefreshMinutes === 'number' && Number.isFinite(record.billingRefreshMinutes)
      ? { billingRefreshMinutes: record.billingRefreshMinutes }
      : {}),
    ...(typeof record.billingAllocationCredits === 'number' && record.billingAllocationCredits > 0
      ? { billingAllocationCredits: record.billingAllocationCredits }
      : {}),
    ...(typeof resetDay === 'number' && Number.isInteger(resetDay) && resetDay >= 1 && resetDay <= 28
      ? { billingResetDay: resetDay }
      : {}),
  }
}

export function apply(ctx: Context, rawConfig: unknown = {}): void {
  const config = parseConfig(rawConfig)
  const logger = { info: (message: string) => ctx.logger.info(message) }
  const edgee = ctx.get('edgeeTransport') as { readonly state?: { readonly enabled: boolean; readonly proxyUrl: string; readonly caPath: string } } | undefined
  const initialState = edgee?.state
  const runtime = new CopilotRuntimeManager({ create: (transport) => new OfficialCopilotRuntime(process.cwd(), 'copilot', undefined, transport) },
    initialState?.enabled === true
      ? { mode: 'edgee', proxyUrl: initialState.proxyUrl, caPath: initialState.caPath }
      : { mode: 'direct' })
  const releaseRuntimeService = typeof (ctx as any).provide === 'function'
    ? (ctx as any).provide('copilotTransport', runtime)
    : undefined
  const tracker = new ConsumptionTracker({
    ...(config.usageTracking === undefined ? {} : { enabled: config.usageTracking }),
    ...(config.tokenInputConvention === undefined ? {} : { convention: config.tokenInputConvention }),
    logger,
  })
  // Opt-in persistence: hydrated before recording, then kept in sync.
  const store =
    config.usagePersist === true
      ? new UsageStore(config.usageStorePath ?? defaultStorePath(), logger)
      : undefined
  if (store !== undefined) {
    const data = store.load()
    if (data !== undefined) tracker.hydrate(data)
    tracker.attachStore(store)
  }
  const billing = new BillingReportClient({
    ...(config.billingTokenPath === undefined ? {} : { tokenPath: config.billingTokenPath }),
    ...(config.billingRefreshMinutes === undefined ? {} : { refreshMinutes: config.billingRefreshMinutes }),
    logger,
  })
  const adapter = new GitHubCopilotAdapter(runtime, tracker)
  const authorization = ctx.get('authorization')
  const auth = new CopilotAuthController(
    ctx.credentials,
    authorization,
    runtime,
    new CopilotCliLoginRunner(),
  )

  if (typeof (ctx as any).inject === 'function') ctx.inject(['webServer'], (wctx: any) => {
    wctx.effect(() => wctx.webServer.register({
      kind: 'prefix',
      path: USAGE_ROUTE,
      handler: (req: { method?: string; url?: string }, res: { writeHead(status: number, headers: Record<string, string>): void; end(body: string): void }) => {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname.slice(USAGE_ROUTE.length).replace(/^\/+/, '')
        if (req.method !== 'GET' || path !== '') return sendJson(res, 404, { error: 'unknown route' })
        return sendJson(res, 200, clientUsageSnapshot(tracker, config.billingAllocationCredits, billing.configured))
      },
    }), 'github-copilot: usage route')
  })

  ctx.effect(function* githubCopilotLifecycle() {
    yield ctx.llm.registerAdapter([PROVIDER], adapter)
    if (authorization !== undefined) yield authorization.registerFlow(auth.flow())
    for (const command of commandDefinitions(auth, {
      tracker,
      billing,
      ...(store === undefined ? {} : { store }),
      ...(config.billingAllocationCredits === undefined ? {} : { allocationCredits: config.billingAllocationCredits }),
      resetDay: config.billingResetDay ?? 1,
    })) {
      yield ctx.commands.register(command)
    }
    yield async () => adapter.dispose()
    yield async () => releaseRuntimeService?.()
  }, 'official GitHub Copilot adapter lifecycle')
}

export { GitHubCopilotAdapter } from './adapter.js'
export { CopilotAuthController, COPILOT_CREDENTIAL_KEY } from './auth.js'
export type {
  ActiveRuntimeCall,
  CopilotRuntime,
  LoginRunner,
  RuntimeAuthStatus,
  RuntimeCallRequest,
  RuntimeEvent,
  RuntimeModel,
  RuntimeModelChangeData,
  RuntimeTool,
  RuntimeUsageData,
} from './copilot-runtime.js'
export { classifyCopilotError } from './errors.js'
export { parseAuthState } from './auth-state.js'
export { redactHeaders, redactText, redactUnknown, safeErrorMessage } from './redaction.js'
export {
  CREDIT_USD,
  PRICING_TABLE,
  PRICING_TABLE_RETRIEVED_AT,
  PRICING_TABLE_SOURCE,
  findModelPricing,
  normalizeModelId,
  selectTier,
} from './pricing-table.js'
export type { ModelPricing, PricingTable, PricingTier } from './pricing-table.js'
export { estimateCallCost, estimateResponseCost } from './cost-estimator.js'
export type { CallEstimate, CostEstimate, EstimateInput, ResponseEstimate } from './cost-estimator.js'
export { ConsumptionTracker, ResponseUsageCollector, toReplayUsage } from './usage-tracker.js'
export type {
  ConsumptionSnapshot,
  ConsumptionTrackerOptions,
  InputConventionConfig,
  ModelAggregate,
  ModelChangeRecord,
  MonthSnapshot,
  ResolvedConvention,
  ResponseUsageSummary,
} from './usage-tracker.js'
export { NANO_AIU_PER_CREDIT, UNCALIBRATED, nanoAiuToCredits, proposeCalibration } from './calibration.js'
export type { CalibrationProposal, CalibrationState } from './calibration.js'
export {
  BILLING_API_BASE,
  BillingReportClient,
  billedCreditsByModel,
  billedCreditsTotal,
  parseBillingReport,
} from './billing-report.js'
export type { BillingReport, BillingResult, BillingUsageItem } from './billing-report.js'
export { UsageStore, defaultStorePath, parseStoreData } from './usage-store.js'
export type { PersistedMonth, PersistedModelAggregate, UsageStoreData } from './usage-store.js'
export { DEFAULT_PRO_ALLOCATION_CREDITS, estimateVsBilled, formatUsageReport } from './usage-report.js'
