/**
 * Local cost estimation from the dated pricing table.
 *
 * Everything produced here is an ESTIMATE: it is computed from observed token
 * counts and the published per-token rates, not from GitHub billing. Callers
 * must always present it with its `source: 'local-estimate'` marker, and never
 * silently substitute it for the per-request billed cost
 * (`copilotUsage.totalNanoAiu`) when that value is available.
 */

import {
  CREDIT_USD,
  findModelPricing,
  selectTier,
  type ModelPricing,
  type PricingTable,
  type PricingTier,
} from './pricing-table.js'

/** Token counts feeding one estimate; absent buckets are treated as unobserved. */
export interface EstimateInput {
  readonly model: string
  /** Prompt-side tokens billed at the input rate (uncached). */
  readonly inputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly outputTokens?: number
}

export interface CostBreakdown {
  readonly inputCredits: number
  readonly cachedInputCredits: number
  readonly cacheWriteCredits: number
  readonly outputCredits: number
}

export interface CostEstimate {
  readonly source: 'local-estimate'
  readonly tableId: string
  readonly tier: PricingTier['tier']
  readonly credits: number
  readonly usd: number
  readonly breakdown: CostBreakdown
  /**
   * Tokens observed in buckets the table marks "Not applicable". They carry no
   * price and are excluded from the estimate rather than billed at a guessed rate.
   */
  readonly unpricedTokens: number
  /** True when some token buckets were absent; the estimate then covers only what was observed. */
  readonly partial: boolean
}

export type CallEstimate =
  | { readonly ok: true; readonly model: string; readonly estimate: CostEstimate }
  | { readonly ok: false; readonly model: string; readonly reason: 'unknown-model' | 'no-tokens-observed' }

export interface ResponseEstimate {
  readonly source: 'local-estimate'
  readonly pricingTableRetrievedAt: string
  readonly perModel: readonly {
    readonly model: string
    readonly calls: number
    readonly estimate: CostEstimate
  }[]
  readonly totalCredits: number
  readonly totalUsd: number
  /** Models with usage but no pricing table entry; excluded from totals, never guessed. */
  readonly unknownModels: readonly string[]
  /** Models with usage events carrying no token counts at all. */
  readonly uncountedModels: readonly string[]
}

function bucketCredits(tokens: number | undefined, perMillion: number | null): { credits: number; unpriced: number } {
  if (tokens === undefined || tokens <= 0) return { credits: 0, unpriced: 0 }
  if (perMillion === null) return { credits: 0, unpriced: tokens }
  return { credits: (tokens / 1_000_000) * (perMillion / CREDIT_USD), unpriced: 0 }
}

/** Estimate one model call. Unknown models are never priced. */
export function estimateCallCost(input: EstimateInput, table: PricingTable): CallEstimate {
  const pricing: ModelPricing | undefined = findModelPricing(input.model, table)
  if (pricing === undefined) return { ok: false, model: input.model, reason: 'unknown-model' }

  const observed = [input.inputTokens, input.cacheReadTokens, input.cacheWriteTokens, input.outputTokens].some(
    (value) => value !== undefined && value > 0,
  )
  if (!observed) return { ok: false, model: input.model, reason: 'no-tokens-observed' }

  const promptTokens =
    (input.inputTokens ?? 0) + (input.cacheReadTokens ?? 0) + (input.cacheWriteTokens ?? 0)
  const tierSelected = selectTier(pricing, promptTokens)

  const inputBucket = bucketCredits(input.inputTokens, tierSelected.inputPerMillion)
  const cachedBucket = bucketCredits(input.cacheReadTokens, tierSelected.cachedInputPerMillion)
  const cacheWriteBucket = bucketCredits(input.cacheWriteTokens, tierSelected.cacheWritePerMillion)
  const outputBucket = bucketCredits(input.outputTokens, tierSelected.outputPerMillion)

  const credits = inputBucket.credits + cachedBucket.credits + cacheWriteBucket.credits + outputBucket.credits
  const partial = [input.inputTokens, input.outputTokens].some((value) => value === undefined)
  return {
    ok: true,
    model: input.model,
    estimate: {
      source: 'local-estimate',
      tableId: pricing.id,
      tier: tierSelected.tier,
      credits,
      usd: credits * CREDIT_USD,
      breakdown: {
        inputCredits: inputBucket.credits,
        cachedInputCredits: cachedBucket.credits,
        cacheWriteCredits: cacheWriteBucket.credits,
        outputCredits: outputBucket.credits,
      },
      unpricedTokens:
        inputBucket.unpriced + cachedBucket.unpriced + cacheWriteBucket.unpriced + outputBucket.unpriced,
      partial,
    },
  }
}

/**
 * Estimate a whole DSH response, which may aggregate several model calls —
 * possibly on different models after an Auto-mode switch. Models stay listed
 * individually; only same-model calls merge into one line.
 */
export function estimateResponseCost(calls: readonly EstimateInput[], table: PricingTable): ResponseEstimate {
  const perModel = new Map<string, { calls: number; estimate: CostEstimate }>()
  const unknownModels = new Set<string>()
  const uncountedModels = new Set<string>()

  for (const call of calls) {
    const result = estimateCallCost(call, table)
    if (!result.ok) {
      if (result.reason === 'unknown-model') unknownModels.add(call.model)
      else uncountedModels.add(call.model)
      continue
    }
    const existing = perModel.get(result.model)
    if (existing === undefined) {
      perModel.set(result.model, { calls: 1, estimate: result.estimate })
    } else {
      const sum = (a: number, b: number): number => a + b
      perModel.set(result.model, {
        calls: existing.calls + 1,
        estimate: {
          ...result.estimate,
          // Merge tiers conservatively: if the same model was priced in two
          // tiers within one response, report the higher (long-context) one.
          tier: existing.estimate.tier === 'long-context' ? 'long-context' : result.estimate.tier,
          credits: sum(existing.estimate.credits, result.estimate.credits),
          usd: sum(existing.estimate.usd, result.estimate.usd),
          breakdown: {
            inputCredits: sum(existing.estimate.breakdown.inputCredits, result.estimate.breakdown.inputCredits),
            cachedInputCredits: sum(
              existing.estimate.breakdown.cachedInputCredits,
              result.estimate.breakdown.cachedInputCredits,
            ),
            cacheWriteCredits: sum(
              existing.estimate.breakdown.cacheWriteCredits,
              result.estimate.breakdown.cacheWriteCredits,
            ),
            outputCredits: sum(existing.estimate.breakdown.outputCredits, result.estimate.breakdown.outputCredits),
          },
          unpricedTokens: sum(existing.estimate.unpricedTokens, result.estimate.unpricedTokens),
          partial: existing.estimate.partial || result.estimate.partial,
        },
      })
    }
  }

  const entries = [...perModel.entries()].map(([modelName, value]) => ({
    model: modelName,
    calls: value.calls,
    estimate: value.estimate,
  }))
  const totalCredits = entries.reduce((acc, entry) => acc + entry.estimate.credits, 0)
  return {
    source: 'local-estimate',
    pricingTableRetrievedAt: table.retrievedAt,
    perModel: entries,
    totalCredits,
    totalUsd: totalCredits * CREDIT_USD,
    unknownModels: [...unknownModels],
    uncountedModels: [...uncountedModels],
  }
}
