/**
 * GitHub Copilot AI-credit pricing table.
 *
 * This file is DATA, versioned and dated. Rates were captured from the official
 * GitHub Docs page "Models and pricing for GitHub Copilot" on the date below;
 * every figure is USD per 1 million tokens. 1 AI credit = $0.01 USD.
 *
 * When GitHub republishes pricing, update the entries AND `retrievedAt` in the
 * same commit so the table always states the day its figures were true.
 *
 * Long-context tiers: the official table expresses thresholds in "K" without
 * defining the base; this table treats 1K as 1000 tokens (e.g. "> 272K" is
 * `thresholdInputTokens: 272_000`). The threshold compares against the total
 * prompt-side tokens of the call (uncached + cached read + cache write).
 */

export const PRICING_TABLE_SOURCE =
  'https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing'

export const PRICING_TABLE_RETRIEVED_AT = '2026-09-01'

/** USD per AI credit, fixed by GitHub. */
export const CREDIT_USD = 0.01

export type PricingCategory = 'Lightweight' | 'Versatile' | 'Powerful'

export interface PricingTier {
  readonly tier: 'default' | 'long-context'
  /**
   * Inclusive lower bound of total prompt-side tokens selecting this tier.
   * Absent on single-tier models and on the default tier of tiered models.
   */
  readonly thresholdInputTokens?: number
  /** USD per 1M uncached input tokens. */
  readonly inputPerMillion: number
  /** USD per 1M cache-read tokens; null when the model has no cache pricing. */
  readonly cachedInputPerMillion: number | null
  /** USD per 1M cache-write tokens; null when the model has no cache-write pricing. */
  readonly cacheWritePerMillion: number | null
  /** USD per 1M output tokens. */
  readonly outputPerMillion: number
}

export interface ModelPricing {
  /** Canonical table id (normalized display name). */
  readonly id: string
  readonly displayName: string
  readonly vendor: 'OpenAI' | 'Anthropic' | 'Google' | 'Microsoft' | 'xAI' | 'GitHub'
  readonly category: PricingCategory
  /** Extra normalized ids the Copilot API may report for this model. */
  readonly aliases: readonly string[]
  readonly tiers: readonly PricingTier[]
}

export interface PricingTable {
  readonly source: string
  readonly retrievedAt: string
  readonly creditUsd: number
  readonly models: readonly ModelPricing[]
}

/**
 * Normalize a model id for table lookup: lowercase, strip every
 * non-alphanumeric, so 'Claude Sonnet 4.5', 'claude-sonnet-4.5' and
 * 'claude_sonnet_4.5' all land on the same key.
 */
export function normalizeModelId(modelId: string): string {
  return modelId.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function tier(
  inputPerMillion: number,
  cachedInputPerMillion: number | null,
  cacheWritePerMillion: number | null,
  outputPerMillion: number,
  thresholdInputTokens?: number,
): PricingTier {
  return {
    tier: thresholdInputTokens === undefined ? 'default' : 'long-context',
    inputPerMillion,
    cachedInputPerMillion,
    cacheWritePerMillion,
    outputPerMillion,
    ...(thresholdInputTokens === undefined ? {} : { thresholdInputTokens }),
  }
}

function model(
  displayName: string,
  vendor: ModelPricing['vendor'],
  category: PricingCategory,
  tiers: readonly PricingTier[],
  aliases: readonly string[] = [],
): ModelPricing {
  return {
    id: normalizeModelId(displayName),
    displayName,
    vendor,
    category,
    aliases: aliases.map(normalizeModelId),
    tiers,
  }
}

export const PRICING_TABLE: PricingTable = {
  source: PRICING_TABLE_SOURCE,
  retrievedAt: PRICING_TABLE_RETRIEVED_AT,
  creditUsd: CREDIT_USD,
  models: [
    // ── OpenAI ──────────────────────────────────────────────────────────────
    model('GPT-5 mini', 'OpenAI', 'Lightweight', [tier(0.25, 0.025, null, 2.0)]),
    model('GPT-5.3-Codex', 'OpenAI', 'Powerful', [tier(1.75, 0.175, null, 14.0)]),
    model('GPT-5.4', 'OpenAI', 'Versatile', [
      tier(2.5, 0.25, null, 15.0),
      tier(5.0, 0.5, null, 22.5, 272_000),
    ]),
    model('GPT-5.4 mini', 'OpenAI', 'Lightweight', [tier(0.75, 0.075, null, 4.5)]),
    model('GPT-5.4 nano', 'OpenAI', 'Lightweight', [tier(0.2, 0.02, null, 1.25)]),
    model('GPT-5.5', 'OpenAI', 'Powerful', [
      tier(5.0, 0.5, null, 30.0),
      tier(10.0, 1.0, null, 45.0, 272_000),
    ]),
    model('GPT-5.6 Luna', 'OpenAI', 'Lightweight', [
      tier(0.2, 0.02, 0.25, 1.2),
      tier(0.4, 0.04, 0.5, 1.8, 200_000),
    ]),
    model('GPT-5.6 Sol', 'OpenAI', 'Powerful', [
      tier(2.0, 0.2, 2.5, 10.0),
      tier(4.0, 0.4, 5.0, 15.0, 272_000),
    ]),
    model('GPT-5.6 Terra', 'OpenAI', 'Versatile', [
      tier(2.0, 0.2, 2.5, 12.0),
      tier(4.0, 0.4, 5.0, 18.0, 272_000),
    ]),
    // ── Anthropic (always priced with cache write) ──────────────────────────
    model('Claude Haiku 4.5', 'Anthropic', 'Versatile', [tier(1.0, 0.1, 1.25, 5.0)]),
    model('Claude Sonnet 4', 'Anthropic', 'Versatile', [tier(3.0, 0.3, 3.75, 15.0)]),
    model('Claude Sonnet 4.5', 'Anthropic', 'Versatile', [tier(3.0, 0.3, 3.75, 15.0)]),
    model('Claude Sonnet 4.6', 'Anthropic', 'Versatile', [tier(3.0, 0.3, 3.75, 15.0)]),
    model('Claude Sonnet 5', 'Anthropic', 'Versatile', [tier(2.0, 0.2, 2.5, 10.0)]),
    model('Claude Opus 4.5', 'Anthropic', 'Powerful', [tier(5.0, 0.5, 6.25, 25.0)]),
    model('Claude Opus 4.6', 'Anthropic', 'Powerful', [tier(5.0, 0.5, 6.25, 25.0)]),
    model('Claude Opus 4.7', 'Anthropic', 'Powerful', [tier(5.0, 0.5, 6.25, 25.0)]),
    model('Claude Opus 4.8', 'Anthropic', 'Powerful', [tier(5.0, 0.5, 6.25, 25.0)]),
    model('Claude Opus 5', 'Anthropic', 'Powerful', [tier(5.0, 0.5, 6.25, 25.0)]),
    model('Claude Opus 4.8 (fast mode)', 'Anthropic', 'Powerful', [tier(10.0, 1.0, 12.5, 50.0)], [
      'claude-opus-4.8-fast',
    ]),
    model('Claude Fable 5', 'Anthropic', 'Powerful', [tier(10.0, 1.0, 12.5, 50.0)]),
    // ── Google ──────────────────────────────────────────────────────────────
    model('Gemini 3.1 Pro', 'Google', 'Powerful', [
      tier(2.0, 0.2, null, 12.0),
      tier(4.0, 0.4, null, 18.0, 200_000),
    ]),
    model('Gemini 3.5 Flash', 'Google', 'Lightweight', [tier(1.5, 0.15, null, 9.0)]),
    model('Gemini 3.6 Flash', 'Google', 'Versatile', [tier(0.75, 0.075, null, 3.75)]),
    model('Gemini 3.7 Flash', 'Google', 'Versatile', [tier(0.75, 0.075, null, 3.75)]),
    // ── Microsoft ───────────────────────────────────────────────────────────
    model('MAI-Code-1-Flash', 'Microsoft', 'Lightweight', [tier(0.75, 0.075, null, 4.5)]),
    model('MAI-Code-1.1-Flash', 'Microsoft', 'Lightweight', [tier(0.2, 0.02, null, 1.2)]),
    // ── xAI ─────────────────────────────────────────────────────────────────
    model('Grok 4.5', 'xAI', 'Versatile', [
      tier(2.0, 0.5, null, 6.0),
      tier(4.0, 1.0, null, 12.0, 200_000),
    ]),
    // ── Fine-tuned (GitHub) ─────────────────────────────────────────────────
    model('Raptor mini', 'GitHub', 'Versatile', [tier(0.25, 0.025, null, 2.0)]),
  ],
}

/** Look up a model in the table; undefined means "tarif inconnu" — never guess. */
export function findModelPricing(modelId: string, table: PricingTable = PRICING_TABLE): ModelPricing | undefined {
  const key = normalizeModelId(modelId)
  if (key.length === 0) return undefined
  return table.models.find((entry) => entry.id === key || entry.aliases.includes(key))
}

/**
 * Select the applicable tier for a call. The long-context tier applies once
 * the total prompt-side token count strictly exceeds its threshold.
 */
export function selectTier(pricing: ModelPricing, promptTokens: number): PricingTier {
  let selected: PricingTier | undefined
  for (const candidate of pricing.tiers) {
    if (candidate.thresholdInputTokens === undefined || promptTokens > candidate.thresholdInputTokens) {
      if (
        selected === undefined ||
        (candidate.thresholdInputTokens ?? -1) > (selected.thresholdInputTokens ?? -1)
      ) {
        selected = candidate
      }
    }
  }
  // Every table entry has at least one tier; fall back defensively.
  return selected ?? pricing.tiers[0] ?? tier(0, null, null, 0)
}
