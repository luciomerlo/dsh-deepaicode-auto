/**
 * Daily verification of the free model tier.
 *
 * The whole point of the unmetered tier is that it costs nothing, so its
 * membership has to be re-established rather than remembered. This module
 * re-reads the upstream catalog once a day, rebuilds the routing ladder with
 * that catalog as the authority, and records what changed: which models are
 * free now, which stopped being free, and which the catalog no longer lists.
 *
 * The report is persisted so "last verified" survives a restart, and it is the
 * single value the settings page and the `deepaicode_free_models` tool both
 * read.
 *
 * @module dsh-deepaicode-auto/verify
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { dataDir } from './auth.js'

/** Default cadence: once a day. */
export const VERIFY_INTERVAL_MS = 24 * 60 * 60 * 1000

/** A configuration cannot make the check run more often than this. */
export const MIN_VERIFY_INTERVAL_MS = 60 * 1000

/**
 * Resolve the on-disk location of the last verification report.
 * @returns {string} absolute path of the report file.
 */
export function defaultReportPath() {
  return join(dataDir(), 'free-models.json')
}

/**
 * Collect every model the ladder prices at zero Theos.
 * @param {{frontier?: Array<{id: string, theos: number}>, unmetered?: Array<{id: string, theos: number}>}} ladder - the rebuilt ladder.
 * @returns {string[]} free model ids, unmetered tier first.
 */
export function freeModelIds(ladder) {
  const free = (ladder?.unmetered ?? []).map(rung => rung.id)
  for (const rung of ladder?.frontier ?? []) {
    if (rung.theos === 0 && !free.includes(rung.id)) free.push(rung.id)
  }
  return free
}

/**
 * Verifies the free model tier and owns the daily schedule for it.
 */
export class FreeModelVerifier {
  #catalog
  #config
  #logger
  #rebuild
  #now
  #schedule
  #cancel
  #readReport
  #writeReport
  #intervalMs
  #active = false
  /** @type {any} */
  #timer
  #nextAt = null
  /** @type {Promise<any> | undefined} */
  #inflight
  /** @type {any} */
  #report = {
    checkedAt: 0,
    verified: false,
    catalogLive: false,
    catalogCount: 0,
    freeIds: [],
    added: [],
    removed: [],
    reclassified: [],
    skipped: [],
  }

  /**
   * @param {object} parts - collaborators.
   * @param {import('./catalog.js').ModelCatalog} parts.catalog - the model catalog.
   * @param {Record<string, any>} parts.config - resolved plugin config.
   * @param {{info: Function, warn: Function, debug: Function}} parts.logger - diagnostics sink.
   * @param {() => object} parts.rebuild - rebuilds the router ladder and returns it.
   * @param {() => number} [parts.now] - clock, injectable for tests.
   * @param {(callback: () => void, ms: number) => any} [parts.schedule] - timer factory.
   * @param {(timer: any) => void} [parts.cancel] - timer canceller.
   * @param {() => Promise<any>} [parts.readReport] - loads the persisted report.
   * @param {(report: any) => Promise<void>} [parts.writeReport] - persists the report.
   */
  constructor(parts) {
    this.#catalog = parts.catalog
    this.#config = parts.config
    this.#logger = parts.logger
    this.#rebuild = parts.rebuild
    this.#now = parts.now ?? Date.now
    this.#schedule = parts.schedule ?? ((callback, ms) => setTimeout(callback, ms))
    this.#cancel = parts.cancel ?? (timer => clearTimeout(timer))
    this.#readReport = parts.readReport ?? (() => readJson(defaultReportPath()))
    this.#writeReport = parts.writeReport ?? (async report => writeJson(defaultReportPath(), report))
    this.#intervalMs = intervalOf(parts.config)
  }

  /** @returns {number} the configured cadence in milliseconds. */
  get intervalMs() {
    return this.#intervalMs
  }

  /**
   * The last verification, as the settings page and the tool report it.
   * @returns {object} a detached snapshot.
   */
  report() {
    return {
      ...this.#report,
      freeIds: [...this.#report.freeIds],
      added: [...this.#report.added],
      removed: [...this.#report.removed],
      reclassified: this.#report.reclassified.map(entry => ({ ...entry })),
      skipped: [...this.#report.skipped],
      intervalMs: this.#intervalMs,
      nextCheckAt: this.#nextAt,
      scheduled: this.#active,
      ageMs: this.#report.checkedAt === 0 ? null : this.#now() - this.#report.checkedAt,
    }
  }

  /**
   * Load the persisted report, so the first diff of a session is real, and arm
   * the daily schedule.
   * @returns {Promise<void>} resolves once the stored report is loaded.
   */
  async start() {
    if (this.#active) return
    await this.#hydrate()
    this.#active = true
    this.#arm()
  }

  /** Stop the daily schedule. Safe to call more than once. */
  stop() {
    this.#active = false
    if (this.#timer !== undefined) {
      this.#cancel(this.#timer)
      this.#timer = undefined
    }
    this.#nextAt = null
  }

  /**
   * Re-read the catalog, rebuild the tiers, and record what changed.
   * @param {{force?: boolean}} [options] - `force` ignores the catalog TTL.
   * @returns {Promise<object>} the report just produced.
   */
  async verify(options = {}) {
    if (this.#inflight !== undefined) return this.#inflight
    this.#inflight = this.#run(options).finally(() => {
      this.#inflight = undefined
    })
    return this.#inflight
  }

  /**
   * The body of one verification.
   * @param {{force?: boolean}} options - `force` ignores the catalog TTL.
   * @returns {Promise<object>} the report just produced.
   */
  async #run(options) {
    const failuresBefore = this.#catalog.failures
    await this.#catalog.refresh({ force: options.force === true })
    const readFailed = this.#catalog.failures > failuresBefore

    const ladder = this.#rebuild() ?? {}
    const freeIds = freeModelIds(ladder)
    // The first run of a fresh install has nothing to compare against, so it
    // establishes the baseline instead of reporting every model as new.
    const baseline = this.#report.checkedAt === 0
    const previous = new Set(this.#report.freeIds)
    const current = new Set(freeIds)

    const report = {
      checkedAt: this.#now(),
      verified: this.#catalog.live && !readFailed,
      catalogLive: this.#catalog.live,
      catalogCount: this.#catalog.list().size,
      freeIds,
      added: baseline ? [] : freeIds.filter(id => !previous.has(id)),
      removed: baseline ? [] : [...previous].filter(id => !current.has(id)),
      reclassified: (ladder.reclassified ?? []).map(entry => ({ ...entry })),
      skipped: [...(ladder.skipped ?? [])],
    }
    this.#report = report

    await this.#writeReport(report).catch(error => {
      this.#logger.warn('deepaicode: could not persist the free-model check', error)
    })

    if (readFailed) {
      this.#logger.warn('deepaicode: the daily free-model check could not read the upstream catalog; keeping the previous tiers')
    } else if (report.removed.length > 0 || report.reclassified.length > 0) {
      this.#logger.warn(
        `deepaicode: free-model check — ${String(report.reclassified.length)} configured free model(s) are now paid`
        + `${report.removed.length > 0 ? `, ${String(report.removed.length)} left the catalog` : ''}`,
      )
    }
    if (report.added.length > 0) {
      this.#logger.info(`deepaicode: free-model check — newly free: ${report.added.join(', ')}`)
    }
    this.#logger.info(
      `deepaicode: free-model check complete — ${String(freeIds.length)} free model(s)`
      + `${report.catalogLive ? ' from the live catalog' : ' from the published table (not verified yet)'}`,
    )
    return this.report()
  }

  /** Read the persisted report into memory, ignoring an absent or malformed file. */
  async #hydrate() {
    try {
      const stored = await this.#readReport()
      if (stored === null || typeof stored !== 'object') return
      if (!Array.isArray(stored.freeIds)) return
      this.#report = {
        checkedAt: Number.isFinite(stored.checkedAt) ? stored.checkedAt : 0,
        verified: stored.verified === true,
        catalogLive: stored.catalogLive === true,
        catalogCount: Number.isFinite(stored.catalogCount) ? stored.catalogCount : 0,
        freeIds: stored.freeIds.filter(id => typeof id === 'string'),
        added: Array.isArray(stored.added) ? stored.added.filter(id => typeof id === 'string') : [],
        removed: Array.isArray(stored.removed) ? stored.removed.filter(id => typeof id === 'string') : [],
        reclassified: Array.isArray(stored.reclassified) ? stored.reclassified : [],
        skipped: Array.isArray(stored.skipped) ? stored.skipped.filter(id => typeof id === 'string') : [],
      }
    } catch {
      // A missing or unreadable report simply means there is no baseline yet.
    }
  }

  /** Arm the next daily run. */
  #arm() {
    this.#nextAt = this.#now() + this.#intervalMs
    this.#timer = this.#schedule(() => {
      this.#timer = undefined
      this.#nextAt = null
      if (!this.#active) return
      void this.verify({ force: true })
        .catch(error => { this.#logger.warn('deepaicode: the daily free-model check failed', error) })
        .finally(() => { if (this.#active) this.#arm() })
    }, this.#intervalMs)
    this.#timer?.unref?.()
  }
}

/**
 * Clamp the configured cadence into a sane range.
 * @param {Record<string, any>} config - resolved plugin config.
 * @returns {number} the cadence in milliseconds.
 */
function intervalOf(config) {
  const configured = config?.verifyFreeModelsEveryMs
  if (!Number.isFinite(configured)) return VERIFY_INTERVAL_MS
  return Math.max(MIN_VERIFY_INTERVAL_MS, configured)
}

/**
 * Read one JSON file.
 * @param {string} path - file to read.
 * @returns {Promise<unknown>} the parsed value.
 */
async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

/**
 * Write one JSON file atomically.
 * @param {string} path - file to write.
 * @param {unknown} value - value to serialize.
 * @returns {Promise<void>} resolves once written.
 */
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${String(process.pid)}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}
