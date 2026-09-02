/**
 * Opt-in local persistence for consumption statistics.
 *
 * Disabled by default. When enabled, the file contains ONLY counters, model
 * ids, costs, timestamps and request-correlation aggregates — never prompts,
 * code, or any message content. The file is created 0600 and its permissions
 * are verified (and repaired) on every load; a too-permissive file is fixed
 * and the repair is logged. Purge is available via `/copilot-usage-reset`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { UNCALIBRATED, parseCalibrationState, type CalibrationState } from './calibration.js'
import { safeErrorMessage } from './redaction.js'

export const USAGE_STORE_VERSION = 1

export interface PersistedModelAggregate {
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

export interface PersistedMonth {
  responses: number
  modelCalls: number
  nanoAiuTotal: number
  estimatedCredits: number
  estimatedUsd: number
  perModel: Record<string, PersistedModelAggregate>
}

export interface UsageStoreData {
  readonly version: typeof USAGE_STORE_VERSION
  readonly updatedAt: string
  readonly calibration: CalibrationState
  readonly months: Record<string, PersistedMonth>
}

interface StoreLogger {
  info(message: string): void
}

/** Default path lives in the user state directory, never inside the repo. */
export function defaultStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const stateHome =
    env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== ''
      ? env.XDG_STATE_HOME
      : join(homedir(), '.local', 'state')
  return join(stateHome, 'dsh-llm-github-copilot', 'usage.json')
}

function emptyData(now: string): UsageStoreData {
  return { version: USAGE_STORE_VERSION, updatedAt: now, calibration: UNCALIBRATED, months: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function parseModelAggregate(value: unknown): PersistedModelAggregate {
  const record = isRecord(value) ? value : {}
  return {
    responses: num(record.responses),
    calls: num(record.calls),
    inputTokens: num(record.inputTokens),
    outputTokens: num(record.outputTokens),
    cacheReadTokens: num(record.cacheReadTokens),
    cacheWriteTokens: num(record.cacheWriteTokens),
    reasoningTokens: num(record.reasoningTokens),
    nanoAiu: num(record.nanoAiu),
    estimatedCredits: num(record.estimatedCredits),
    estimatedUsd: num(record.estimatedUsd),
  }
}

/** Lenient parse: a corrupt or partial file degrades to an empty store, never to a crash. */
export function parseStoreData(value: unknown, now: string): UsageStoreData {
  if (!isRecord(value) || value.version !== USAGE_STORE_VERSION) return emptyData(now)
  const months: Record<string, PersistedMonth> = {}
  if (isRecord(value.months)) {
    for (const [month, raw] of Object.entries(value.months)) {
      if (!/^\d{4}-\d{2}$/.test(month) || !isRecord(raw)) continue
      const perModel: Record<string, PersistedModelAggregate> = {}
      if (isRecord(raw.perModel)) {
        for (const [model, aggregate] of Object.entries(raw.perModel)) perModel[model] = parseModelAggregate(aggregate)
      }
      months[month] = {
        responses: num(raw.responses),
        modelCalls: num(raw.modelCalls),
        nanoAiuTotal: num(raw.nanoAiuTotal),
        estimatedCredits: num(raw.estimatedCredits),
        estimatedUsd: num(raw.estimatedUsd),
        perModel,
      }
    }
  }
  return {
    version: USAGE_STORE_VERSION,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : now,
    calibration: parseCalibrationState(value.calibration),
    months,
  }
}

export class UsageStore {
  constructor(
    readonly path: string,
    private readonly logger?: StoreLogger,
  ) {}

  /** True when a store file exists on disk. */
  exists(): boolean {
    return existsSync(this.path)
  }

  /**
   * Load the store. Permissions are verified first: anything more permissive
   * than 0600 is repaired to 0600 and the repair is logged. A missing or
   * unreadable file returns undefined (the plugin keeps running in memory).
   */
  load(): UsageStoreData | undefined {
    if (!existsSync(this.path)) return undefined
    this.enforcePermissions()
    try {
      return parseStoreData(JSON.parse(readFileSync(this.path, 'utf8')), new Date().toISOString())
    } catch (error) {
      this.logger?.info(`llm-github-copilot: usage store unreadable, starting empty (${safeErrorMessage(error)})`)
      return undefined
    }
  }

  /** Persist atomically (tmp + rename) with 0600 permissions. */
  save(data: UsageStoreData): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 })
    renameSync(temporary, this.path)
    this.enforcePermissions()
  }

  /** Delete the store file. Returns whether a file was removed. */
  purge(): boolean {
    if (!existsSync(this.path)) return false
    unlinkSync(this.path)
    return true
  }

  private enforcePermissions(): void {
    try {
      const mode = statSync(this.path).mode & 0o777
      if (mode !== 0o600) {
        chmodSync(this.path, 0o600)
        this.logger?.info(
          `llm-github-copilot: usage store permissions were ${mode.toString(8)}, repaired to 600`,
        )
      }
    } catch (error) {
      this.logger?.info(`llm-github-copilot: could not verify usage store permissions (${safeErrorMessage(error)})`)
    }
  }
}
