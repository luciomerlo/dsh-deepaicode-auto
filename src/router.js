/**
 * Auto (DeepAiCode) routing policy: strict Frontier -> Unmetered priority with
 * hot failover.
 *
 * The router owns no I/O and no timers beyond reading a clock, so every rule
 * below is exercised directly by the unit tests.
 *
 * @module dsh-deepaicode-auto/router
 */

/** Cooldown applied to a model that failed for a transient reason. */
export const TRANSIENT_COOLDOWN_MS = 60_000

/** Cooldown applied to a model that rejected the request shape itself. */
export const REJECTED_COOLDOWN_MS = 10 * 60_000

/** Cooldown applied when the provider reports the session busy. */
export const BUSY_COOLDOWN_MS = 15_000

/**
 * @typedef {object} Candidate
 * @property {string} id - upstream model id.
 * @property {'frontier' | 'unmetered'} tier - which rung this model sits on.
 * @property {string} label - display label.
 * @property {number} theos - expected cost per request.
 * @property {string} api - wire family.
 * @property {number} contextWindow - advertised capacity.
 * @property {number} maxTokens - advertised output cap.
 */

/**
 * @typedef {object} FailureFacts
 * @property {number} [status] - HTTP status observed, when there was one.
 * @property {string} [code] - provider or client failure code.
 * @property {string} [message] - provider text, used for quota wording.
 */

const QUOTA_WORDS = /check_in_refused|network_bound|quota|daily limit|out of theos|insufficient|exhausted|allowance/i
const AUTH_WORDS = /invalid api key|api key|unauthori[sz]ed|forbidden|auth/i

/**
 * Wording upstream uses when the conversation does not fit the model.
 *
 * Upstream answers `400` with code `context_length_exceeded` and the sentence
 * "This conversation exceeds the context window. Compact it to continue." The
 * request is too large for the model; the model itself is fine.
 */
const CONTEXT_WORDS = new RegExp([
  String.raw`context[\s_-](?:length|window)[\s_-]?(?:exceed\w*|overflow\w*|limit[\s_-]exceeded)`,
  String.raw`(?:exceed\w*|overflow\w*)\s+the\s+context(?:\s+(?:length|window))?`,
  String.raw`(?:maximum|max)\s+context\s+(?:length|window)`,
  String.raw`too\s+(?:long|large)\s+for\s+(?:this|the)\s+model`,
].join('|'), 'i')

/**
 * Whether a failure means the conversation outgrew the model's context window.
 * @param {FailureFacts} facts - observed failure.
 * @returns {boolean} true for a context-overflow failure.
 */
export function isContextOverflow(facts) {
  return CONTEXT_WORDS.test(`${facts.code ?? ''} ${facts.message ?? ''}`)
}

/**
 * Classify an upstream failure into the reaction the router takes.
 * @param {FailureFacts} facts - observed failure.
 * @returns {'auth' | 'quota' | 'context' | 'lane' | 'busy' | 'rejected' | 'transient'}
 *   `auth` aborts the whole attempt chain, `quota` retires the paid tier for the
 *   day, `context` is request-specific (the model is healthy, the conversation is
 *   too big) and cools nothing, `lane` asks the client to raise its lane header,
 *   and the rest cool the model down for a while.
 */
export function classifyFailure(facts) {
  const status = facts.status
  const text = `${facts.code ?? ''} ${facts.message ?? ''}`
  // Checked before the generic 400 branch: an overflow is not a rejected request
  // shape, and treating it as one would cool every model down instead of letting
  // the harness condense the conversation and retry.
  if (isContextOverflow(facts)) return 'context'
  if (status === 426) return 'lane'
  if (status === 409) return 'busy'
  if (status === 401) return 'auth'
  if (status === 403) {
    if (QUOTA_WORDS.test(text)) return 'quota'
    if (AUTH_WORDS.test(text)) return 'auth'
    return 'quota'
  }
  if (/QUOTA_EXCEEDED/i.test(facts.code ?? '') || QUOTA_WORDS.test(text)) return 'quota'
  if (/AUTH/i.test(facts.code ?? '') && !/[45]\d\d/.test(text)) return 'auth'
  if (status === 429) return 'quota'
  if (status === 400 || status === 413 || status === 422) return 'rejected'
  if (/INVALID_REQUEST|MALFORMED_RESPONSE|EMPTY_RESPONSE/i.test(facts.code ?? '')) return 'rejected'
  return 'transient'
}

/**
 * Wall-clock instant of the next daily allowance reset (next UTC midnight).
 * @param {number} now - current epoch milliseconds.
 * @returns {number} epoch milliseconds of the next reset.
 */
export function nextDailyReset(now) {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0)
}

/**
 * The Auto (DeepAiCode) router.
 *
 * Priority is strict: every Frontier rung still affordable and not cooling down
 * comes before any Unmetered rung. Unmetered models never consume allowance, so
 * they are ordered by the configured priority rather than by cost.
 */
export class AutoRouter {
  /** @type {{frontier: Candidate[], unmetered: Candidate[]}} */
  #ladder = { frontier: [], unmetered: [] }
  /** @type {Map<string, number>} */
  #cooldownUntil = new Map()
  /** @type {Map<string, string>} */
  #cooldownReason = new Map()
  /** @type {Set<string>} */
  #exhausted = new Set()
  /** @type {number | null} */
  #remaining = null
  /** @type {number} */
  #budget
  /** @type {number} */
  #maxFailovers
  /** @type {() => number} */
  #now
  /** @type {Array<{at: number, from: string, to: string, reason: string}>} */
  #history = []
  /** @type {Array<{at: number, model: string, tier: string, theos: number, ok: boolean}>} */
  #log = []

  /**
   * @param {object} [options] - router tuning.
   * @param {number} [options.budget] - daily allowance in Theos.
   * @param {number} [options.maxFailovers] - maximum models tried per request.
   * @param {() => number} [options.now] - clock, injectable for tests.
   */
  constructor(options = {}) {
    this.#budget = Number.isFinite(options.budget) && options.budget > 0 ? options.budget : 250
    this.#maxFailovers = Number.isInteger(options.maxFailovers) && options.maxFailovers > 0 ? options.maxFailovers : 8
    this.#now = options.now ?? Date.now
  }

  /**
   * Install the model ladder the router walks.
   * @param {{frontier?: Candidate[], unmetered?: Candidate[]}} ladder - ordered rungs.
   * @returns {void}
   */
  setLadder(ladder) {
    this.#ladder = {
      frontier: Array.isArray(ladder?.frontier) ? ladder.frontier : [],
      unmetered: Array.isArray(ladder?.unmetered) ? ladder.unmetered : [],
    }
  }

  /** @returns {{frontier: Candidate[], unmetered: Candidate[]}} the installed ladder. */
  get ladder() {
    return this.#ladder
  }

  /**
   * Record the allowance the provider reported.
   * @param {number | null | undefined} remaining - Theos left today, or null when unknown.
   * @param {number} [budget] - provider-reported daily allowance.
   * @returns {void}
   */
  setQuota(remaining, budget) {
    this.#remaining = typeof remaining === 'number' && Number.isFinite(remaining) ? Math.max(0, remaining) : null
    if (Number.isFinite(budget) && budget > 0) this.#budget = budget
    if (this.#remaining !== null && this.#remaining > 0) this.#exhausted.clear()
  }

  /** @returns {number | null} Theos left today, or null when unknown. */
  get remaining() {
    return this.#remaining
  }

  /** @returns {number} daily allowance in Theos. */
  get budget() {
    return this.#budget
  }

  /**
   * Expand every stale cooldown and cleared day before planning.
   * @param {number} now - current epoch milliseconds.
   * @returns {void}
   */
  #expire(now) {
    for (const [id, until] of this.#cooldownUntil) {
      if (until <= now) {
        this.#cooldownUntil.delete(id)
        this.#cooldownReason.delete(id)
      }
    }
    if (this.#exhausted.size > 0) {
      const reset = nextDailyReset(now)
      if (now >= reset) this.#exhausted.clear()
    }
  }

  /**
   * Whether one model may be attempted now.
   * @param {Candidate} candidate - rung to test.
   * @param {number} now - current epoch milliseconds.
   * @returns {boolean} true when the model is neither cooling down nor retired.
   */
  #available(candidate, now) {
    if (this.#exhausted.has(candidate.id)) return false
    const until = this.#cooldownUntil.get(candidate.id)
    return until === undefined || until <= now
  }

  /**
   * Whether the remaining allowance covers one Frontier rung.
   * An unknown allowance is treated as sufficient so the router prefers a
   * Frontier model, exactly as the product promises.
   * @param {Candidate} candidate - Frontier rung.
   * @returns {boolean} true when the rung is affordable.
   */
  #affordable(candidate) {
    if (this.#remaining === null) return true
    return candidate.theos <= this.#remaining
  }

  /**
   * The ordered attempt list for one request.
   * @returns {Candidate[]} Frontier rungs first, then Unmetered rungs, capped by `maxFailovers`.
   */
  plan() {
    const now = this.#now()
    this.#expire(now)
    /** @type {Candidate[]} */
    const frontier = []
    /** @type {Candidate[]} */
    const unmetered = []
    for (const candidate of this.#ladder.frontier) {
      if (!this.#available(candidate, now)) continue
      if (!this.#affordable(candidate)) continue
      frontier.push(candidate)
    }
    for (const candidate of this.#ladder.unmetered) {
      if (!this.#available(candidate, now)) continue
      unmetered.push(candidate)
    }
    // `maxFailovers` bounds the expensive tier only. Capping the combined list
    // would let a long Frontier ladder push the free tier out of the plan
    // entirely, so a run could exhaust every paid model and still never reach a
    // model that costs nothing.
    return [...frontier.slice(0, this.#maxFailovers), ...unmetered]
  }

  /**
   * Record a successful attempt.
   *
   * The allowance is deliberately **not** decremented here. Upstream bills a
   * Frontier request per token rather than per request — a published "~15
   * Theos" model costs a fraction of that for a short answer — so a local
   * estimate would be off by orders of magnitude and would drop the router to
   * the unmetered tier long before the account ran out. The reported balance
   * from `/theos` is the only authority, and {@link setQuota} publishes it.
   *
   * @param {Candidate} candidate - the model that answered.
   * @returns {void}
   */
  recordSuccess(candidate) {
    this.#log.push({ at: this.#now(), model: candidate.id, tier: candidate.tier, theos: candidate.theos, ok: true })
    if (this.#log.length > 200) this.#log.shift()
  }

  /**
   * Record a failed attempt and apply the reaction its class demands.
   * @param {Candidate} candidate - the model that failed.
   * @param {FailureFacts} facts - observed failure.
   * @returns {'auth' | 'quota' | 'context' | 'transient' | 'rejected'} the reaction applied.
   */
  recordFailure(candidate, facts) {
    const now = this.#now()
    const kind = classifyFailure(facts)
    this.#log.push({ at: now, model: candidate.id, tier: candidate.tier, theos: candidate.theos, ok: false })
    if (this.#log.length > 200) this.#log.shift()
    switch (kind) {
      case 'auth':
        return 'auth'
      case 'context':
        // Request-specific: this model is healthy, the conversation is simply
        // bigger than it can hold. Cooling it down would disqualify a working
        // model for the next, smaller request, so nothing is retired here.
        return 'context'
      case 'quota':
        this.#exhausted.add(candidate.id)
        this.#cooldownReason.set(candidate.id, 'quota')
        // A Frontier refusal for the account's daily allowance retires the whole
        // paid tier: every other Frontier model draws on the same balance, so
        // retrying them would only repeat the same 403. Clearing the estimate
        // also makes the next plan start at the free tier.
        if (candidate.tier === 'frontier') this.#remaining = 0
        return 'quota'
      case 'busy':
        this.#cooldownUntil.set(candidate.id, now + BUSY_COOLDOWN_MS)
        this.#cooldownReason.set(candidate.id, 'busy')
        return 'transient'
      case 'rejected':
        this.#cooldownUntil.set(candidate.id, now + REJECTED_COOLDOWN_MS)
        this.#cooldownReason.set(candidate.id, 'rejected')
        return 'rejected'
      case 'lane':
      case 'transient':
      default:
        this.#cooldownUntil.set(candidate.id, now + TRANSIENT_COOLDOWN_MS)
        this.#cooldownReason.set(candidate.id, kind)
        return 'transient'
    }
  }

  /**
   * Remember which model replaced which, for the plugin's observability surface.
   * @param {string} from - model that failed.
   * @param {string} to - model tried next, or `'none'` when the chain ended.
   * @param {string} reason - failure class that caused the step.
   * @returns {void}
   */
  recordHandoff(from, to, reason) {
    this.#history.push({ at: this.#now(), from, to, reason })
    if (this.#history.length > 50) this.#history.shift()
  }

  /**
   * Read the routing state for logging and the plugin's status surface.
   * @returns {object} a detached snapshot.
   */
  snapshot() {
    const now = this.#now()
    this.#expire(now)
    return {
      remainingTheos: this.#remaining,
      budget: this.#budget,
      frontierReady: this.#ladder.frontier.filter(c => this.#available(c, now) && this.#affordable(c)).map(c => c.id),
      frontierCooling: [...this.#cooldownUntil.keys()].filter(id => this.#cooldownUntil.get(id) > now),
      exhausted: [...this.#exhausted],
      unmeteredReady: this.#ladder.unmetered.filter(c => this.#available(c, now)).map(c => c.id),
      recentHandoffs: [...this.#history],
      recentAttempts: [...this.#log],
    }
  }

  /**
   * Why one model is currently skipped.
   * @param {string} id - model id.
   * @returns {string | undefined} a human-readable reason, or undefined when it is ready.
   */
  blockedReason(id) {
    if (this.#exhausted.has(id)) return this.#cooldownReason.get(id) === 'quota' ? 'daily allowance exhausted' : 'retired'
    const until = this.#cooldownUntil.get(id)
    if (until !== undefined && until > this.#now()) {
      return `cooling down (${this.#cooldownReason.get(id) ?? 'error'}) for ${Math.ceil((until - this.#now()) / 1000)}s`
    }
    return undefined
  }
}
