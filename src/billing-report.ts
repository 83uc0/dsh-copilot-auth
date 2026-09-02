/**
 * Client for the official GitHub AI-credit billing report:
 *   GET /users/{username}/settings/billing/ai_credit/usage
 *
 * Authentication uses a DEDICATED fine-grained PAT (user permission "Plan",
 * read) read from a file whose path is configured — never the plugin's
 * Copilot OAuth token, which is neither accessible nor permitted for this
 * call. The token is never logged, never persisted by this plugin, and no
 * request body ever leaves the process (the endpoint is a GET).
 *
 * Calls are never triggered by a message: only the /copilot-usage family of
 * commands fetches, behind a cache with an enforced minimum refresh interval.
 */

import { readFileSync, statSync } from 'node:fs'
import { safeErrorMessage } from './redaction.js'

export const GITHUB_API_VERSION = '2026-03-10'
export const BILLING_API_BASE = 'https://api.github.com'

/** Hard floor between any two network calls, manual refresh included. */
export const MIN_FETCH_INTERVAL_MS = 60_000
/** Default cache TTL; configuration may raise it, never lower it. */
export const DEFAULT_REFRESH_MINUTES = 60

export interface BillingUsageItem {
  readonly product: string
  readonly sku: string
  readonly model: string
  readonly unitType: string
  readonly pricePerUnit: number
  readonly grossQuantity: number
  readonly grossAmount: number
  readonly discountQuantity: number
  readonly discountAmount: number
  readonly netQuantity: number
  readonly netAmount: number
}

export interface BillingReport {
  readonly timePeriod: { readonly year: number; readonly month?: number; readonly day?: number }
  readonly user: string
  readonly usageItems: readonly BillingUsageItem[]
}

export type BillingFailureReason =
  | 'no-token-configured'
  | 'token-unreadable'
  | 'http-401'
  | 'http-403'
  | 'http-404'
  | 'http-429'
  | 'http-error'
  | 'endpoint-unavailable'
  | 'invalid-response'

export interface BillingFailure {
  readonly ok: false
  readonly reason: BillingFailureReason
  readonly message: string
  readonly status?: number
  /** Value of X-Accepted-GitHub-Permissions on a 403, when GitHub sent one. */
  readonly acceptedPermissions?: string
}

export type BillingResult =
  | {
      readonly ok: true
      readonly report: BillingReport
      readonly fetchedAt: string
      readonly fromCache: boolean
    }
  | BillingFailure

interface BillingLogger {
  info(message: string): void
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface BillingReportClientOptions {
  /** Path to a file containing ONLY the fine-grained PAT (0600 expected). */
  readonly tokenPath?: string
  readonly fetchFn?: FetchLike
  readonly logger?: BillingLogger
  readonly now?: () => Date
  /** Requested cache TTL in minutes; clamped to the enforced minimum. */
  readonly refreshMinutes?: number
}

function parseUsageItem(value: unknown): BillingUsageItem | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.grossQuantity !== 'number') return undefined
  const str = (key: string): string => (typeof record[key] === 'string' ? (record[key] as string) : '')
  const num = (key: string): number => (typeof record[key] === 'number' ? (record[key] as number) : 0)
  return {
    product: str('product'),
    sku: str('sku'),
    model: str('model'),
    unitType: str('unitType'),
    pricePerUnit: num('pricePerUnit'),
    grossQuantity: num('grossQuantity'),
    grossAmount: num('grossAmount'),
    discountQuantity: num('discountQuantity'),
    discountAmount: num('discountAmount'),
    netQuantity: num('netQuantity'),
    netAmount: num('netAmount'),
  }
}

/** Strict-enough parse of the documented response schema; unknown shapes are rejected, not guessed. */
export function parseBillingReport(value: unknown): BillingReport | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const timePeriod = record.timePeriod
  if (timePeriod === null || typeof timePeriod !== 'object' || Array.isArray(timePeriod)) return undefined
  const year = (timePeriod as Record<string, unknown>).year
  if (typeof year !== 'number') return undefined
  if (!Array.isArray(record.usageItems)) return undefined
  const month = (timePeriod as Record<string, unknown>).month
  const day = (timePeriod as Record<string, unknown>).day
  return {
    timePeriod: {
      year,
      ...(typeof month === 'number' ? { month } : {}),
      ...(typeof day === 'number' ? { day } : {}),
    },
    user: typeof record.user === 'string' ? record.user : '',
    usageItems: record.usageItems
      .map(parseUsageItem)
      .filter((item): item is BillingUsageItem => item !== undefined),
  }
}

export class BillingReportClient {
  readonly #tokenPath?: string
  readonly #fetchFn: FetchLike
  readonly #logger?: BillingLogger
  readonly #now: () => Date
  readonly #refreshMs: number
  #cache?: { readonly periodKey: string; readonly fetchedAtMs: number; readonly report: BillingReport }
  #lastFetchMs = 0
  #permissionHintLogged = false

  constructor(options: BillingReportClientOptions = {}) {
    if (options.tokenPath !== undefined && options.tokenPath !== '') this.#tokenPath = options.tokenPath
    this.#fetchFn = options.fetchFn ?? fetch
    if (options.logger !== undefined) this.#logger = options.logger
    this.#now = options.now ?? (() => new Date())
    const requested = options.refreshMinutes ?? DEFAULT_REFRESH_MINUTES
    const minutes = Math.max(requested, DEFAULT_REFRESH_MINUTES)
    if (requested < DEFAULT_REFRESH_MINUTES) {
      this.#logger?.info(
        `llm-github-copilot: billingRefreshMinutes=${String(requested)} is below the enforced minimum; using ${String(DEFAULT_REFRESH_MINUTES)}`,
      )
    }
    this.#refreshMs = minutes * 60_000
  }

  get configured(): boolean {
    return this.#tokenPath !== undefined
  }

  get refreshMinutes(): number {
    return this.#refreshMs / 60_000
  }

  /** Read the PAT from its file; warns when permissions are wider than 0600. Never logs the token. */
  readToken(): { token: string } | BillingFailure {
    if (this.#tokenPath === undefined) {
      return {
        ok: false,
        reason: 'no-token-configured',
        message:
          'No billing token configured (billingTokenPath). Running in estimate-only mode; see README "Billing reconciliation".',
      }
    }
    try {
      const mode = statSync(this.#tokenPath).mode & 0o777
      if ((mode & 0o077) !== 0) {
        this.#logger?.info(
          `llm-github-copilot: billing token file permissions are ${mode.toString(8)}; recommend chmod 600`,
        )
      }
      const token = readFileSync(this.#tokenPath, 'utf8').trim()
      if (token.length === 0) {
        return { ok: false, reason: 'token-unreadable', message: 'Billing token file is empty.' }
      }
      return { token }
    } catch (error) {
      return { ok: false, reason: 'token-unreadable', message: safeErrorMessage(error) }
    }
  }

  /**
   * Fetch the billing report for a period, served from cache when fresh.
   * `force` bypasses the TTL but not the hard floor between network calls.
   */
  async report(
    username: string,
    period: { readonly year: number; readonly month: number },
    options: { readonly force?: boolean } = {},
  ): Promise<BillingResult> {
    const periodKey = `${String(period.year)}-${String(period.month).padStart(2, '0')}`
    const nowMs = this.#now().getTime()
    const cached = this.#cache
    if (
      options.force !== true &&
      cached !== undefined &&
      cached.periodKey === periodKey &&
      nowMs - cached.fetchedAtMs < this.#refreshMs
    ) {
      return { ok: true, report: cached.report, fetchedAt: new Date(cached.fetchedAtMs).toISOString(), fromCache: true }
    }

    const token = this.readToken()
    if (!('token' in token)) return token

    if (nowMs - this.#lastFetchMs < MIN_FETCH_INTERVAL_MS) {
      if (cached !== undefined && cached.periodKey === periodKey) {
        return {
          ok: true,
          report: cached.report,
          fetchedAt: new Date(cached.fetchedAtMs).toISOString(),
          fromCache: true,
        }
      }
      return {
        ok: false,
        reason: 'http-429',
        message: 'Billing refresh is rate-limited locally; try again shortly.',
      }
    }

    const url = `${BILLING_API_BASE}/users/${encodeURIComponent(username)}/settings/billing/ai_credit/usage?year=${String(period.year)}&month=${String(period.month)}`
    let response: Response
    this.#lastFetchMs = nowMs
    try {
      response = await this.#fetchFn(url, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token.token}`,
          'x-github-api-version': GITHUB_API_VERSION,
        },
      })
    } catch (error) {
      return {
        ok: false,
        reason: 'endpoint-unavailable',
        message: `GitHub billing endpoint unreachable: ${safeErrorMessage(error)}`,
      }
    }

    if (response.status !== 200) {
      return this.#httpFailure(response)
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      return { ok: false, reason: 'invalid-response', message: 'Billing endpoint returned a non-JSON body.' }
    }
    const report = parseBillingReport(body)
    if (report === undefined) {
      return { ok: false, reason: 'invalid-response', message: 'Billing endpoint response did not match the documented schema.' }
    }
    this.#cache = { periodKey, fetchedAtMs: nowMs, report }
    return { ok: true, report, fetchedAt: new Date(nowMs).toISOString(), fromCache: false }
  }

  async #httpFailure(response: Response): Promise<BillingFailure> {
    // The body is drained but never logged: error payloads can echo request details.
    await response.body?.cancel().catch(() => undefined)
    const status = response.status
    if (status === 403) {
      const accepted = response.headers.get('x-accepted-github-permissions')
      if (accepted !== null && accepted !== '' && !this.#permissionHintLogged) {
        this.#permissionHintLogged = true
        // Documents the permission GitHub actually requires; never logs the token.
        this.#logger?.info(`llm-github-copilot: billing endpoint requires permissions: ${accepted}`)
      }
      return {
        ok: false,
        reason: 'http-403',
        status,
        message:
          'GitHub returned 403 for the billing report. The fine-grained PAT needs the user "Plan" read permission.',
        ...(accepted !== null && accepted !== '' ? { acceptedPermissions: accepted } : {}),
      }
    }
    const reasons: Record<number, BillingFailureReason> = {
      401: 'http-401',
      404: 'http-404',
      429: 'http-429',
    }
    const reason = reasons[status] ?? 'http-error'
    const messages: Record<string, string> = {
      'http-401': 'GitHub returned 401: the billing token is invalid or expired.',
      'http-404': 'GitHub returned 404: no billing data for this account/period (plan may have no AI-credit data).',
      'http-429': 'GitHub returned 429: billing endpoint rate limit; cached data kept when available.',
    }
    return {
      ok: false,
      reason,
      status,
      message: messages[reason] ?? `GitHub billing endpoint returned HTTP ${String(status)}.`,
    }
  }
}

/** Sum billed credits per model for a report (grossQuantity is the consumed quantity). */
export function billedCreditsByModel(report: BillingReport): ReadonlyMap<string, number> {
  const perModel = new Map<string, number>()
  for (const item of report.usageItems) {
    perModel.set(item.model, (perModel.get(item.model) ?? 0) + item.grossQuantity)
  }
  return perModel
}

/** Total billed credits (gross) for a report. */
export function billedCreditsTotal(report: BillingReport): number {
  return report.usageItems.reduce((acc, item) => acc + item.grossQuantity, 0)
}
