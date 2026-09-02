/**
 * Per-response and per-session consumption tracking for the Copilot route.
 *
 * Data comes exclusively from SDK session events (`assistant.usage`,
 * `session.model_change`) relayed as runtime events — never from HTTP headers
 * (the official CLI owns the connection) and never from estimates of the
 * prompt. When the SDK reports no usage for a response, nothing is invented:
 * the response is recorded with `usageObserved: false` and surfaced as such.
 *
 * Isolation contract: tracking must never break a model response. Every
 * recorder entry point swallows its own errors and counts them; the count and
 * the last redacted message are exposed in the snapshot for `/copilot-usage`.
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { UNCALIBRATED, type CalibrationState } from './calibration.js'
import { estimateResponseCost, type ResponseEstimate } from './cost-estimator.js'
import type { RuntimeModelChangeData, RuntimeUsageData } from './copilot-runtime.js'
import { PRICING_TABLE, type PricingTable } from './pricing-table.js'
import { safeErrorMessage } from './redaction.js'
import type { PersistedModelAggregate, PersistedMonth, UsageStore, UsageStoreData } from './usage-store.js'

/**
 * Config token-convention knob. `auto` observes real events; the other two
 * force a convention for providers whose `inputTokens` semantics are known.
 */
export type InputConventionConfig = 'auto' | 'disjoint' | 'inclusive'

/**
 * Resolved convention applied to produce DSH's disjoint TokenUsage.
 * `unsubtracted-ambiguous` means no observation proved `inputTokens` excludes
 * cache reads, so nothing was subtracted: if the provider actually folds cache
 * reads into `inputTokens`, billed input is over-reported (documented bias).
 */
export type ResolvedConvention = 'disjoint' | 'inclusive' | 'unsubtracted-ambiguous'

export interface ModelChangeRecord {
  readonly at: string
  readonly newModel: string
  readonly previousModel?: string
  readonly cause?: string
}

export interface ResponseUsageSummary {
  readonly at: string
  readonly requestedModel: string
  readonly responseText?: string
  /** One entry per `assistant.usage` event; several models may appear after an Auto-mode switch. */
  readonly calls: readonly RuntimeUsageData[]
  readonly modelChanges: readonly ModelChangeRecord[]
  /** False when no token bucket was observed; no usage chunk is emitted then. */
  readonly usageObserved: boolean
  /** Disjoint token counts per the resolved convention; absent when nothing was observed. */
  readonly tokens?: TokenUsage
  readonly convention: ResolvedConvention
  /** True when some observed calls were missing token buckets. */
  readonly tokensPartial: boolean
  /** Raw nano-AI-unit total from CAPI; the nano→credit conversion is calibrated elsewhere. */
  readonly nanoAiuTotal?: number
  /** How many calls carried `copilotUsage.totalNanoAiu`. */
  readonly nanoAiuObservedCalls: number
  /** Local estimate from the dated pricing table; models unknown to it are excluded, never guessed. */
  readonly estimate?: ResponseEstimate
}

export interface ModelAggregate {
  readonly model: string
  readonly tableKnown: boolean
  responses: number
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  nanoAiu: number
  estimatedCredits: number
  estimatedUsd: number
}

export interface ConsumptionSnapshot {
  readonly enabled: boolean
  readonly startedAt: string
  readonly responses: number
  readonly responsesWithoutUsage: number
  readonly modelCalls: number
  readonly convention: ResolvedConvention
  readonly conventionSource: 'configured' | 'observed' | 'default-unsubtracted'
  readonly isolationErrors: number
  readonly lastError?: string
  readonly nanoAiuTotal: number
  readonly estimatedCredits: number
  readonly estimatedUsd: number
  readonly perModel: readonly ModelAggregate[]
  readonly unknownModels: readonly string[]
  readonly modelChanges: readonly ModelChangeRecord[]
  readonly recentResponses: readonly ResponseUsageSummary[]
  readonly calibration: CalibrationState
  readonly persisted: boolean
}

/** One calendar month of consumption, merged from persistence and live traffic. */
export interface MonthSnapshot {
  readonly month: string
  readonly responses: number
  readonly modelCalls: number
  readonly nanoAiuTotal: number
  readonly estimatedCredits: number
  readonly estimatedUsd: number
  readonly perModel: readonly ModelAggregate[]
}

interface MonthBucket {
  responses: number
  modelCalls: number
  nanoAiuTotal: number
  estimatedCredits: number
  estimatedUsd: number
  perModel: Map<string, ModelAggregate>
}

function emptyMonth(): MonthBucket {
  return {
    responses: 0,
    modelCalls: 0,
    nanoAiuTotal: 0,
    estimatedCredits: 0,
    estimatedUsd: 0,
    perModel: new Map(),
  }
}

interface TrackerLogger {
  info(message: string): void
}

export interface ConsumptionTrackerOptions {
  readonly enabled?: boolean
  readonly convention?: InputConventionConfig
  readonly pricingTable?: PricingTable
  readonly logger?: TrackerLogger
  readonly now?: () => Date
}

const RECENT_RESPONSES_CAP = 20
const MODEL_CHANGES_CAP = 50

/** Per-stream collector: accumulates usage events until the terminal event. */
export class ResponseUsageCollector {
  readonly #calls: RuntimeUsageData[] = []
  readonly #changes: ModelChangeRecord[] = []
  #responseText = ''

  constructor(private readonly now: () => Date) {}

  addCall(data: RuntimeUsageData): void {
    this.#calls.push(data)
  }

  addModelChange(data: RuntimeModelChangeData): void {
    this.#changes.push({
      at: this.now().toISOString(),
      newModel: data.newModel,
      ...(data.previousModel === undefined ? {} : { previousModel: data.previousModel }),
      ...(data.cause === undefined ? {} : { cause: data.cause }),
    })
  }

  addText(text: string): void {
    this.#responseText += text
  }

  get callCount(): number {
    return this.#calls.length
  }

  /** Copy of the observed calls, for the tracker's convention detection pass. */
  get calls(): readonly RuntimeUsageData[] {
    return [...this.#calls]
  }

  get hasData(): boolean {
    return this.#calls.length > 0 || this.#changes.length > 0
  }

  summarize(requestedModel: string, convention: ResolvedConvention, table: PricingTable): ResponseUsageSummary {
    const calls = [...this.#calls]
    const usageObserved = calls.some(
      (call) =>
        call.inputTokens !== undefined ||
        call.outputTokens !== undefined ||
        call.cacheReadTokens !== undefined ||
        call.cacheWriteTokens !== undefined,
    )
    const tokensPartial = calls.some((call) => call.inputTokens === undefined || call.outputTokens === undefined)

    let tokens: TokenUsage | undefined
    if (usageObserved) {
      let input = 0
      let output = 0
      let cacheRead = 0
      let cacheWrite = 0
      let reasoning = 0
      let sawCacheRead = false
      let sawCacheWrite = false
      let sawReasoning = false
      for (const call of calls) {
        const rawInput = call.inputTokens ?? 0
        // Convention application: only a proven `inclusive`/`disjoint` split
        // may subtract; ambiguity keeps the raw figure (documented bias).
        const uncached =
          convention === 'inclusive' ? Math.max(0, rawInput - (call.cacheReadTokens ?? 0)) : rawInput
        input += uncached
        output += call.outputTokens ?? 0
        if (call.cacheReadTokens !== undefined) {
          sawCacheRead = true
          cacheRead += call.cacheReadTokens
        }
        if (call.cacheWriteTokens !== undefined) {
          sawCacheWrite = true
          cacheWrite += call.cacheWriteTokens
        }
        if (call.reasoningTokens !== undefined) {
          sawReasoning = true
          reasoning += call.reasoningTokens
        }
      }
      tokens = {
        inputTokens: input,
        outputTokens: output,
        ...(sawCacheRead ? { cacheReadTokens: cacheRead } : {}),
        ...(sawCacheWrite ? { cacheWriteTokens: cacheWrite } : {}),
        ...(sawReasoning ? { reasoningTokens: reasoning } : {}),
      }
    }

    let nanoAiuTotal = 0
    let nanoAiuObservedCalls = 0
    for (const call of calls) {
      if (call.nanoAiu !== undefined) {
        nanoAiuObservedCalls += 1
        nanoAiuTotal += call.nanoAiu
      }
    }

    const estimateCalls = calls.map((call) => ({
      model: call.model,
      ...(call.inputTokens === undefined
        ? {}
        : {
            inputTokens:
              convention === 'inclusive' ? Math.max(0, call.inputTokens - (call.cacheReadTokens ?? 0)) : call.inputTokens,
          }),
      ...(call.cacheReadTokens === undefined ? {} : { cacheReadTokens: call.cacheReadTokens }),
      ...(call.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: call.cacheWriteTokens }),
      ...(call.outputTokens === undefined ? {} : { outputTokens: call.outputTokens }),
    }))
    const estimate = calls.length > 0 ? estimateResponseCost(estimateCalls, table) : undefined

    return {
      at: this.now().toISOString(),
      requestedModel,
      ...(this.#responseText === '' ? {} : { responseText: this.#responseText }),
      calls,
      modelChanges: [...this.#changes],
      usageObserved,
      ...(tokens === undefined ? {} : { tokens }),
      convention,
      tokensPartial,
      ...(nanoAiuObservedCalls === 0 ? {} : { nanoAiuTotal }),
      nanoAiuObservedCalls,
      ...(estimate === undefined ? {} : { estimate }),
    }
  }
}

function emptyAggregate(model: string, tableKnown: boolean): ModelAggregate {
  return {
    model,
    tableKnown,
    responses: 0,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    nanoAiu: 0,
    estimatedCredits: 0,
    estimatedUsd: 0,
  }
}

/**
 * Plugin-lifetime tracker: owns the token-convention detection state, the
 * in-memory session aggregates, and the isolation error counter. Persistence
 * is layered on top in Lot 2 and stays opt-in; with storage disabled the
 * snapshot covers the current process only.
 */
export class ConsumptionTracker {
  readonly enabled: boolean
  readonly #table: PricingTable
  readonly #logger?: TrackerLogger
  readonly #now: () => Date
  readonly #forcedConvention?: 'disjoint' | 'inclusive'
  #observedConvention: 'unknown' | 'disjoint' = 'unknown'
  #conventionLogged = false

  readonly #startedAt: string
  #responses = 0
  #responsesWithoutUsage = 0
  #modelCalls = 0
  #isolationErrors = 0
  #lastError?: string
  #nanoAiuTotal = 0
  #estimatedCredits = 0
  #estimatedUsd = 0
  readonly #perModel = new Map<string, ModelAggregate>()
  readonly #unknownModels = new Set<string>()
  readonly #modelChanges: ModelChangeRecord[] = []
  readonly #recentResponses: ResponseUsageSummary[] = []
  readonly #months = new Map<string, MonthBucket>()
  #calibration: CalibrationState = UNCALIBRATED
  #store?: UsageStore

  constructor(options: ConsumptionTrackerOptions = {}) {
    this.enabled = options.enabled !== false
    this.#table = options.pricingTable ?? PRICING_TABLE
    this.#now = options.now ?? (() => new Date())
    if (options.logger !== undefined) this.#logger = options.logger
    if (options.convention === 'disjoint' || options.convention === 'inclusive') {
      this.#forcedConvention = options.convention
    }
    this.#startedAt = this.#now().toISOString()
    if (this.enabled && this.#forcedConvention !== undefined) {
      this.#logOnce(`usage tracking: token input convention forced to "${this.#forcedConvention}" by configuration`)
    }
  }

  startResponse(): ResponseUsageCollector {
    return new ResponseUsageCollector(this.#now)
  }

  /**
   * Convention auto-detection. `inputTokens < cacheReadTokens` is only possible
   * when the provider reports disjoint buckets, so one such observation proves
   * the disjoint convention. The inclusive convention is never auto-detected
   * (no observation can prove it); ambiguity keeps the raw, unsubtracted value.
   */
  observeCall(call: RuntimeUsageData): void {
    if (this.#forcedConvention !== undefined || this.#observedConvention !== 'unknown') return
    // Disjoint proof: inputTokens below EITHER cache bucket (live observation
    // 2026-09-01: Auto-mode GPT-5.6 Terra reported inputTokens 3 alongside
    // cacheWriteTokens 3747 -- only possible with disjoint buckets).
    const cacheMax = Math.max(call.cacheReadTokens ?? 0, call.cacheWriteTokens ?? 0)
    if (call.inputTokens !== undefined && call.inputTokens < cacheMax) {
      this.#observedConvention = 'disjoint'
      this.#logOnce(
        'usage tracking: observed inputTokens below a cache bucket, so the provider reports disjoint token buckets; cache tokens are reported separately',
      )
    }
  }

  convention(): ResolvedConvention {
    if (this.#forcedConvention !== undefined) return this.#forcedConvention
    if (this.#observedConvention === 'disjoint') return 'disjoint'
    return 'unsubtracted-ambiguous'
  }

  conventionSource(): ConsumptionSnapshot['conventionSource'] {
    if (this.#forcedConvention !== undefined) return 'configured'
    if (this.#observedConvention === 'disjoint') return 'observed'
    return 'default-unsubtracted'
  }

  summarize(collector: ResponseUsageCollector, requestedModel: string): ResponseUsageSummary {
    for (const call of collector.calls) this.observeCall(call)
    return collector.summarize(requestedModel, this.convention(), this.#table)
  }

  recordResponse(summary: ResponseUsageSummary): void {
    try {
      this.#responses += 1
      if (!summary.usageObserved) this.#responsesWithoutUsage += 1
      this.#modelCalls += summary.calls.length
      if (summary.nanoAiuTotal !== undefined) this.#nanoAiuTotal += summary.nanoAiuTotal
      if (summary.estimate !== undefined) {
        this.#estimatedCredits += summary.estimate.totalCredits
        this.#estimatedUsd += summary.estimate.totalUsd
        for (const model of summary.estimate.unknownModels) this.#unknownModels.add(model)
      }
      for (const change of summary.modelChanges) this.#recordModelChange(change)
      const countedResponses = new Set<string>()
      for (const call of summary.calls) {
        const known =
          summary.estimate === undefined ? false : !summary.estimate.unknownModels.includes(call.model)
        const aggregate = this.#perModel.get(call.model) ?? emptyAggregate(call.model, known)
        if (!countedResponses.has(call.model)) {
          aggregate.responses += 1
          countedResponses.add(call.model)
        }
        aggregate.calls += 1
        aggregate.inputTokens += call.inputTokens ?? 0
        aggregate.outputTokens += call.outputTokens ?? 0
        aggregate.cacheReadTokens += call.cacheReadTokens ?? 0
        aggregate.cacheWriteTokens += call.cacheWriteTokens ?? 0
        aggregate.reasoningTokens += call.reasoningTokens ?? 0
        aggregate.nanoAiu += call.nanoAiu ?? 0
        this.#perModel.set(call.model, aggregate)
      }
      if (summary.estimate !== undefined) {
        for (const entry of summary.estimate.perModel) {
          const aggregate = this.#perModel.get(entry.model)
          if (aggregate !== undefined) {
            aggregate.estimatedCredits += entry.estimate.credits
            aggregate.estimatedUsd += entry.estimate.usd
          }
        }
      }
      this.#recentResponses.push(summary)
      if (this.#recentResponses.length > RECENT_RESPONSES_CAP) this.#recentResponses.shift()
      this.#recordMonth(summary)
      this.#persist()
    } catch (error) {
      this.recordError('record response', error)
    }
  }

  /** Attach the opt-in persistent store (called after hydration). */
  attachStore(store: UsageStore): void {
    this.#store = store
  }

  /** Load persisted months and calibration, typically right after startup. */
  hydrate(data: UsageStoreData): void {
    try {
      this.#calibration = data.calibration
      for (const [month, persisted] of Object.entries(data.months)) {
        const bucket = emptyMonth()
        bucket.responses = persisted.responses
        bucket.modelCalls = persisted.modelCalls
        bucket.nanoAiuTotal = persisted.nanoAiuTotal
        bucket.estimatedCredits = persisted.estimatedCredits
        bucket.estimatedUsd = persisted.estimatedUsd
        for (const [model, aggregate] of Object.entries(persisted.perModel)) {
          bucket.perModel.set(model, {
            model,
            tableKnown: true,
            responses: aggregate.responses,
            calls: aggregate.calls,
            inputTokens: aggregate.inputTokens,
            outputTokens: aggregate.outputTokens,
            cacheReadTokens: aggregate.cacheReadTokens,
            cacheWriteTokens: aggregate.cacheWriteTokens,
            reasoningTokens: aggregate.reasoningTokens,
            nanoAiu: aggregate.nanoAiu,
            estimatedCredits: aggregate.estimatedCredits,
            estimatedUsd: aggregate.estimatedUsd,
          })
        }
        this.#months.set(month, bucket)
      }
    } catch (error) {
      this.recordError('hydrate usage store', error)
    }
  }

  calibration(): CalibrationState {
    return this.#calibration
  }

  /** Apply a user-confirmed calibration and persist it. */
  applyCalibration(state: CalibrationState): void {
    this.#calibration = state
    this.#persist()
  }

  /** Month view (persisted months merged with live traffic), for /copilot-usage. */
  month(monthKey: string): MonthSnapshot | undefined {
    const bucket = this.#months.get(monthKey)
    if (bucket === undefined) return undefined
    return {
      month: monthKey,
      responses: bucket.responses,
      modelCalls: bucket.modelCalls,
      nanoAiuTotal: bucket.nanoAiuTotal,
      estimatedCredits: bucket.estimatedCredits,
      estimatedUsd: bucket.estimatedUsd,
      perModel: [...bucket.perModel.values()].map((aggregate) => ({ ...aggregate })),
    }
  }

  /** Local nano-AIU total of one month, for the calibration proposal. */
  monthNanoAiu(monthKey: string): number {
    return this.#months.get(monthKey)?.nanoAiuTotal ?? 0
  }

  /** Clear every aggregate (used by /copilot-usage-reset after the store purge). */
  resetAggregates(): void {
    this.#responses = 0
    this.#responsesWithoutUsage = 0
    this.#modelCalls = 0
    this.#nanoAiuTotal = 0
    this.#estimatedCredits = 0
    this.#estimatedUsd = 0
    this.#perModel.clear()
    this.#unknownModels.clear()
    this.#modelChanges.length = 0
    this.#recentResponses.length = 0
    this.#months.clear()
    this.#calibration = UNCALIBRATED
  }

  #recordMonth(summary: ResponseUsageSummary): void {
    const monthKey = summary.at.slice(0, 7)
    const bucket = this.#months.get(monthKey) ?? emptyMonth()
    bucket.responses += 1
    bucket.modelCalls += summary.calls.length
    bucket.nanoAiuTotal += summary.nanoAiuTotal ?? 0
    bucket.estimatedCredits += summary.estimate?.totalCredits ?? 0
    bucket.estimatedUsd += summary.estimate?.totalUsd ?? 0
    const counted = new Set<string>()
    for (const call of summary.calls) {
      const known = summary.estimate === undefined ? false : !summary.estimate.unknownModels.includes(call.model)
      const aggregate = bucket.perModel.get(call.model) ?? emptyAggregate(call.model, known)
      if (!counted.has(call.model)) {
        aggregate.responses += 1
        counted.add(call.model)
      }
      aggregate.calls += 1
      aggregate.inputTokens += call.inputTokens ?? 0
      aggregate.outputTokens += call.outputTokens ?? 0
      aggregate.cacheReadTokens += call.cacheReadTokens ?? 0
      aggregate.cacheWriteTokens += call.cacheWriteTokens ?? 0
      aggregate.reasoningTokens += call.reasoningTokens ?? 0
      aggregate.nanoAiu += call.nanoAiu ?? 0
      bucket.perModel.set(call.model, aggregate)
    }
    if (summary.estimate !== undefined) {
      for (const entry of summary.estimate.perModel) {
        const aggregate = bucket.perModel.get(entry.model)
        if (aggregate !== undefined) {
          aggregate.estimatedCredits += entry.estimate.credits
          aggregate.estimatedUsd += entry.estimate.usd
        }
      }
    }
    this.#months.set(monthKey, bucket)
  }

  #persist(): void {
    if (this.#store === undefined) return
    try {
      const months: Record<string, PersistedMonth> = {}
      for (const [monthKey, bucket] of this.#months) {
        const perModel: Record<string, PersistedModelAggregate> = {}
        for (const [model, aggregate] of bucket.perModel) {
          perModel[model] = {
            responses: aggregate.responses,
            calls: aggregate.calls,
            inputTokens: aggregate.inputTokens,
            outputTokens: aggregate.outputTokens,
            cacheReadTokens: aggregate.cacheReadTokens,
            cacheWriteTokens: aggregate.cacheWriteTokens,
            reasoningTokens: aggregate.reasoningTokens,
            nanoAiu: aggregate.nanoAiu,
            estimatedCredits: aggregate.estimatedCredits,
            estimatedUsd: aggregate.estimatedUsd,
          }
        }
        months[monthKey] = {
          responses: bucket.responses,
          modelCalls: bucket.modelCalls,
          nanoAiuTotal: bucket.nanoAiuTotal,
          estimatedCredits: bucket.estimatedCredits,
          estimatedUsd: bucket.estimatedUsd,
          perModel,
        }
      }
      this.#store.save({
        version: 1,
        updatedAt: this.#now().toISOString(),
        calibration: this.#calibration,
        months,
      })
    } catch (error) {
      this.recordError('persist usage store', error)
    }
  }

  recordError(context: string, error: unknown): void {
    this.#isolationErrors += 1
    this.#lastError = `${context}: ${safeErrorMessage(error)}`
  }

  snapshot(): ConsumptionSnapshot {
    return {
      enabled: this.enabled,
      startedAt: this.#startedAt,
      responses: this.#responses,
      responsesWithoutUsage: this.#responsesWithoutUsage,
      modelCalls: this.#modelCalls,
      convention: this.convention(),
      conventionSource: this.conventionSource(),
      isolationErrors: this.#isolationErrors,
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
      nanoAiuTotal: this.#nanoAiuTotal,
      estimatedCredits: this.#estimatedCredits,
      estimatedUsd: this.#estimatedUsd,
      perModel: [...this.#perModel.values()].map((aggregate) => ({ ...aggregate })),
      unknownModels: [...this.#unknownModels],
      modelChanges: [...this.#modelChanges],
      recentResponses: [...this.#recentResponses],
      calibration: this.#calibration,
      persisted: this.#store !== undefined,
    }
  }

  #recordModelChange(change: ModelChangeRecord): void {
    this.#modelChanges.push(change)
    if (this.#modelChanges.length > MODEL_CHANGES_CAP) this.#modelChanges.shift()
    const cause = change.cause === undefined ? '' : ` (cause: ${change.cause})`
    const from = change.previousModel === undefined ? '?' : change.previousModel
    this.#logger?.info(`llm-github-copilot: model change ${from} → ${change.newModel}${cause}`)
  }

  #logOnce(message: string): void {
    if (this.#conventionLogged) return
    this.#conventionLogged = true
    this.#logger?.info(`llm-github-copilot: ${message}`)
  }
}

export const REPLAY_USAGE_VERSION = 1

/**
 * Adapter-private, lossless-JSON metadata attached to the terminal `finish`
 * chunk (`ReplayEnvelope.response`) and stored with the assistant message.
 * Keeps the per-call detail — several models may appear after an Auto-mode
 * switch — so no consumer ever collapses the response to a single model.
 * Contains counters, model ids, latencies, request ids, and the RAW nano-AIU
 * total only: no prompt, no content, and no nano-AIU→credit conversion (that
 * conversion is calibrated state, owned by the billing side).
 */
export function toReplayUsage(summary: ResponseUsageSummary): Record<string, unknown> {
  return {
    copilotUsage: {
      version: REPLAY_USAGE_VERSION,
      at: summary.at,
      requestedModel: summary.requestedModel,
      convention: summary.convention,
      usageObserved: summary.usageObserved,
      tokensPartial: summary.tokensPartial,
      tokens: summary.tokens ?? null,
      calls: summary.calls.map((call) => ({ ...call })),
      models: summarizeModels(summary),
      modelChanges: summary.modelChanges.map((change) => ({ ...change })),
      nanoAiuTotal: summary.nanoAiuTotal ?? null,
      nanoAiuObservedCalls: summary.nanoAiuObservedCalls,
      estimate:
        summary.estimate === undefined
          ? null
          : {
              source: summary.estimate.source,
              pricingTableRetrievedAt: summary.estimate.pricingTableRetrievedAt,
              totalCredits: summary.estimate.totalCredits,
              totalUsd: summary.estimate.totalUsd,
              perModel: summary.estimate.perModel.map((entry) => ({
                model: entry.model,
                calls: entry.calls,
                credits: entry.estimate.credits,
                usd: entry.estimate.usd,
                tier: entry.estimate.tier,
                partial: entry.estimate.partial,
              })),
              unknownModels: [...summary.estimate.unknownModels],
              uncountedModels: [...summary.estimate.uncountedModels],
            },
    },
  }
}

/** Per-model roll-up of one response; a list, never a single collapsed model. */
function summarizeModels(summary: ResponseUsageSummary): readonly Record<string, unknown>[] {
  const byModel = new Map<string, { calls: number; nanoAiu: number; hasNanoAiu: boolean }>()
  for (const call of summary.calls) {
    const entry = byModel.get(call.model) ?? { calls: 0, nanoAiu: 0, hasNanoAiu: false }
    entry.calls += 1
    if (call.nanoAiu !== undefined) {
      entry.hasNanoAiu = true
      entry.nanoAiu += call.nanoAiu
    }
    byModel.set(call.model, entry)
  }
  const estimates = new Map(summary.estimate?.perModel.map((entry) => [entry.model, entry]) ?? [])
  return [...byModel.entries()].map(([model, entry]) => {
    const estimate = estimates.get(model)
    return {
      model,
      calls: entry.calls,
      nanoAiu: entry.hasNanoAiu ? entry.nanoAiu : null,
      estimatedCredits: estimate?.estimate.credits ?? null,
      pricing: summary.estimate?.unknownModels.includes(model) === true ? 'unknown' : 'known',
    }
  })
}
