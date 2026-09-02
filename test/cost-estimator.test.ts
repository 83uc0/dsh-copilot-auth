import { describe, expect, it } from 'vitest'
import { estimateCallCost, estimateResponseCost } from '../src/cost-estimator.js'
import {
  CREDIT_USD,
  PRICING_TABLE,
  findModelPricing,
  normalizeModelId,
  selectTier,
} from '../src/pricing-table.js'

describe('pricing table', () => {
  it('is dated and sourced, with the fixed credit rate', () => {
    expect(PRICING_TABLE.source).toContain('docs.github.com')
    expect(PRICING_TABLE.retrievedAt).toBe('2026-09-01')
    expect(CREDIT_USD).toBe(0.01)
    expect(PRICING_TABLE.models.length).toBeGreaterThan(20)
  })

  it('matches model ids case- and separator-insensitively', () => {
    expect(normalizeModelId('Claude Sonnet 4.5')).toBe(normalizeModelId('claude-sonnet-4.5'))
    expect(findModelPricing('claude-sonnet-4.5')?.displayName).toBe('Claude Sonnet 4.5')
    expect(findModelPricing('GPT-5.4')?.displayName).toBe('GPT-5.4')
    expect(findModelPricing('gemini-3.1-pro')?.displayName).toBe('Gemini 3.1 Pro')
    expect(findModelPricing('grok-4.5')?.displayName).toBe('Grok 4.5')
    // 'GPT-5.4' must not resolve to the mini/nano variants.
    expect(findModelPricing('gpt-5.4')?.displayName).toBe('GPT-5.4')
  })

  it('returns undefined for unknown models — never a guessed entry', () => {
    expect(findModelPricing('gpt-99-ultra')).toBeUndefined()
    expect(findModelPricing('')).toBeUndefined()
  })

  it('selects the long-context tier strictly above the threshold', () => {
    const gpt54 = findModelPricing('gpt-5.4')
    expect(gpt54).toBeDefined()
    if (gpt54 === undefined) return
    expect(selectTier(gpt54, 272_000).tier).toBe('default')
    expect(selectTier(gpt54, 272_001).tier).toBe('long-context')
    expect(selectTier(gpt54, 0).tier).toBe('default')
  })
})

describe('cost estimator', () => {
  it('prices a straightforward call at the default tier', () => {
    // 100K input stays below the 272K long-context threshold.
    const result = estimateCallCost(
      { model: 'gpt-5.4', inputTokens: 100_000, outputTokens: 100_000 },
      PRICING_TABLE,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.estimate.tier).toBe('default')
    // $0.25 + $1.50 = $1.75 → 175 credits
    expect(result.estimate.usd).toBeCloseTo(1.75, 9)
    expect(result.estimate.credits).toBeCloseTo(175, 6)
    expect(result.estimate.partial).toBe(false)
  })

  it('applies long-context rates once the prompt crosses the threshold', () => {
    const below = estimateCallCost({ model: 'gpt-5.4', inputTokens: 272_000, outputTokens: 0 }, PRICING_TABLE)
    const above = estimateCallCost({ model: 'gpt-5.4', inputTokens: 272_001, outputTokens: 0 }, PRICING_TABLE)
    expect(below.ok && below.estimate.tier).toBe('default')
    expect(above.ok && above.estimate.tier).toBe('long-context')
    if (below.ok && above.ok) {
      expect(below.estimate.usd).toBeCloseTo(0.68, 9) // 272K @ $2.50/1M
      expect(above.estimate.usd).toBeCloseTo(1.360005, 9) // 272001 @ $5.00/1M
    }
  })

  it('bills cached input and cache write at their own rates, not the input rate', () => {
    const result = estimateCallCost(
      { model: 'claude-sonnet-4.5', inputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
      PRICING_TABLE,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // $3.00 + $0.30 + $3.75 = $7.05 → 705 credits
    expect(result.estimate.usd).toBeCloseTo(7.05, 9)
    expect(result.estimate.breakdown.cachedInputCredits).toBeCloseTo(30, 6)
    expect(result.estimate.breakdown.cacheWriteCredits).toBeCloseTo(375, 6)
  })

  it('excludes cache-write tokens from the estimate when the model has no cache-write price', () => {
    const result = estimateCallCost(
      { model: 'gpt-5.4', inputTokens: 100, cacheWriteTokens: 50, outputTokens: 0 },
      PRICING_TABLE,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.estimate.unpricedTokens).toBe(50)
    // Only the 100 input tokens are priced.
    expect(result.estimate.usd).toBeCloseTo(0.00025, 9)
  })

  it('refuses unknown models and tokenless calls with explicit reasons', () => {
    const unknown = estimateCallCost({ model: 'mystery', inputTokens: 1 }, PRICING_TABLE)
    expect(unknown).toEqual({ ok: false, model: 'mystery', reason: 'unknown-model' })
    const empty = estimateCallCost({ model: 'gpt-5.4' }, PRICING_TABLE)
    expect(empty).toEqual({ ok: false, model: 'gpt-5.4', reason: 'no-tokens-observed' })
  })

  it('aggregates a response per model without merging distinct models', () => {
    const estimate = estimateResponseCost(
      [
        { model: 'gpt-5.4', inputTokens: 100, outputTokens: 10 },
        { model: 'claude-sonnet-4.5', inputTokens: 100, outputTokens: 10 },
        { model: 'mystery', inputTokens: 5, outputTokens: 5 },
        { model: 'gpt-5.4', inputTokens: 100, outputTokens: 10 },
      ],
      PRICING_TABLE,
    )
    expect(estimate.source).toBe('local-estimate')
    expect(estimate.pricingTableRetrievedAt).toBe('2026-09-01')
    expect(estimate.perModel).toHaveLength(2)
    expect(estimate.perModel.find((entry) => entry.model === 'gpt-5.4')?.calls).toBe(2)
    expect(estimate.unknownModels).toEqual(['mystery'])
    // Totals cover only priced models; the unknown one contributes nothing.
    const expectedUsd = 2 * (100 * 2.5 + 10 * 15) * 1e-6 + (100 * 3 + 10 * 15) * 1e-6
    expect(estimate.totalUsd).toBeCloseTo(expectedUsd, 12)
    expect(estimate.totalCredits).toBeCloseTo(expectedUsd / 0.01, 9)
  })

  it('marks estimates partial when a call is missing token buckets', () => {
    const result = estimateCallCost({ model: 'gpt-5.4', outputTokens: 100 }, PRICING_TABLE)
    expect(result.ok && result.estimate.partial).toBe(true)
  })
})
