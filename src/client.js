/**
 * Upstream client for the DeepAI Code endpoints.
 *
 * Upstream is an OpenAI-compatible surface gated on "does this look like the
 * desktop client": an `Api-Key` header (never `Authorization`), a lane version
 * header, a process instance id, a hashed machine fingerprint, a bare `node`
 * user agent, and a periodic `/theos` check-in. This module owns all of that
 * state and exposes plain promises and an SSE body.
 *
 * @module dsh-deepaicode-auto/client
 */

import { randomBytes } from 'node:crypto'

import { buildChatBody, buildResponsesBody, chatBodyFallback } from './body.js'
import { createInstanceId } from './identity.js'

/** Header names, exactly as the desktop client spells them. */
export const HEADER_KEY = 'Api-Key'
export const HEADER_LANE = 'X-DeepAI-Code-Theos'
export const HEADER_MACHINE = 'X-DeepAI-Code-Machine'
export const HEADER_INSTANCE = 'X-DeepAI-Code-Instance'
export const HEADER_CHECK_IN = 'X-DeepAI-Code-Check-In'
export const HEADER_BEACON = 'X-DeepAI-Code-Beacon'
export const HEADER_AFFINITY = 'X-Session-Affinity'

/** Endpoint paths relative to the model base. */
export const PATH_MODELS = '/models'
export const PATH_CHAT = '/chat/completions'
export const PATH_RESPONSES = '/responses'
export const PATH_THEOS = '/theos'

/** Upstream failure codes this client reacts to by name. */
export const CODE_AUTH_REQUIRED = 'auth_required'
export const CODE_INVALID_API_KEY = 'invalid_api_key'
export const CODE_EMAIL_UNVERIFIED = 'email_unverified'
export const CODE_SOCIAL_LOGIN = 'social_login_required'
export const CODE_MACHINE_REQUIRED = 'machine_required'
export const CODE_LANE_UNSUPPORTED = 'lane_version_unsupported'
export const CODE_SESSION_BUSY = 'session_busy'
export const CODE_CHECK_IN_REFUSED = 'check_in_refused'
export const CODE_NETWORK_BOUND = 'network_bound'
export const CODE_THEOS_EXHAUSTED = 'theos_exhausted'

/** Minimum gap between two check-in attempts. */
const CHECK_IN_MIN_INTERVAL_MS = 30_000

/** Time budget for one check-in round trip. */
const CHECK_IN_TIMEOUT_MS = 10_000

/** Cooldown between lane probes, so a lane bump cannot stampede. */
const LANE_PROBE_COOLDOWN_MS = 60_000

/** How long `check_in_refused` silences further check-ins. */
const CHECK_IN_REFUSED_LOCK_MS = 6 * 60 * 60 * 1000

/** How many lane values above the compiled one to guess during a probe. */
const LANE_GUESS_AHEAD = 6

/**
 * A non-2xx upstream response, carrying the semantic code the router reacts to.
 */
export class UpstreamError extends Error {
  /**
   * @param {number} status - HTTP status.
   * @param {string} code - upstream `error.code`.
   * @param {string} message - human-readable summary.
   * @param {string} [body] - raw response body.
   * @param {number} [retryAfter] - upstream `Retry-After` in seconds.
   */
  constructor(status, code, message, body = '', retryAfter) {
    super(message)
    this.name = 'UpstreamError'
    this.status = status
    this.code = code
    this.body = body
    if (retryAfter !== undefined) this.retryAfter = retryAfter
  }

  /** @returns {boolean} the credential itself is unusable. */
  get authFailed() {
    return this.status === 401
      || this.code === CODE_AUTH_REQUIRED
      || this.code === CODE_INVALID_API_KEY
      || this.code === CODE_EMAIL_UNVERIFIED
  }

  /** @returns {boolean} the lane version is rejected and must be re-probed. */
  get laneUnsupported() {
    return this.status === 426 || this.code === CODE_LANE_UNSUPPORTED
  }

  /** @returns {boolean} the request body was rejected as un-desktop-like. */
  get bodyRejected() {
    return this.status === 400 && this.body.toLowerCase().includes('not one deepai code sends')
  }

  /** @returns {boolean} the daily allowance is gone. */
  get allowanceExhausted() {
    return this.code === CODE_THEOS_EXHAUSTED
      || this.code === CODE_NETWORK_BOUND
      || this.code === CODE_CHECK_IN_REFUSED
  }
}

/**
 * Read `error.code` out of an upstream body.
 * @param {string} body - raw response body.
 * @returns {string} the code, or an empty string.
 */
function errorCodeOf(body) {
  try {
    const parsed = JSON.parse(body)
    const code = parsed?.error?.code ?? parsed?.code
    return typeof code === 'string' ? code : ''
  } catch {
    return ''
  }
}

/**
 * Read `error.message` out of an upstream body.
 * @param {string} body - raw response body.
 * @returns {string} the message, truncated for logs.
 */
function errorMessageOf(body) {
  try {
    const parsed = JSON.parse(body)
    const message = parsed?.error?.message ?? parsed?.message
    if (typeof message === 'string' && message !== '') return message
  } catch {
    // Not JSON.
  }
  return body.trim().slice(0, 200)
}

/**
 * Parse a `Retry-After` header into seconds within a sane range.
 * @param {string | null} header - the header value.
 * @param {number} [fallback] - value used when absent or unparsable.
 * @returns {number} seconds between 1 and 30.
 */
export function retryAfterSeconds(header, fallback = 3) {
  if (header === null || header.trim() === '') return fallback
  const parsed = Number.parseInt(header.trim(), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(30, Math.max(1, parsed))
}

/**
 * Validate a check-in challenge the way upstream issues it.
 * @param {{nonce?: unknown, seconds?: unknown} | undefined} challenge - a candidate.
 * @returns {boolean} true when the nonce is 32 lower-case hex and the TTL is positive.
 */
export function isValidCheckIn(challenge) {
  if (challenge === undefined) return false
  if (typeof challenge.seconds !== 'number' || !Number.isFinite(challenge.seconds) || challenge.seconds <= 0) return false
  return typeof challenge.nonce === 'string' && /^[0-9a-f]{32}$/.test(challenge.nonce)
}

/**
 * Choose the lane values to try during a probe: the compiled lane, a few
 * values above it, then older lanes as a last resort.
 * @param {string} compiled - the compiled-in lane.
 * @returns {string[]} candidate lane values in attempt order.
 */
export function laneCandidates(compiled) {
  const base = Number.parseInt(compiled, 10)
  if (!Number.isFinite(base)) return [compiled]
  const out = []
  for (let lane = base; lane <= base + LANE_GUESS_AHEAD; lane += 1) out.push(String(lane))
  for (let lane = base - 1; lane >= 2; lane -= 1) out.push(String(lane))
  return out
}

/**
 * The DeepAI Code upstream client.
 */
export class DeepAiClient {
  /** @type {Record<string, any>} */
  #config
  #instance = createInstanceId()
  #machine = ''
  #apiKey = ''
  #lane
  #laneCheckedAt = 0
  #startedAt = Date.now()
  /** @type {Map<string, any>} */
  #checkIns = new Map()
  /** @type {{warn: (...args: unknown[]) => void} | undefined} */
  #logger

  /**
   * @param {object} options - client wiring.
   * @param {Record<string, any>} options.config - resolved plugin config.
   * @param {{warn: (...args: unknown[]) => void}} [options.logger] - diagnostics sink.
   */
  constructor(options) {
    this.#config = options.config
    this.#logger = options.logger
    this.#lane = String(options.config.lane)
  }

  /** @returns {string} the process instance id sent on every request. */
  get instanceId() {
    return this.#instance
  }

  /** @returns {string} the active lane version. */
  get lane() {
    return this.#lane
  }

  /** @returns {boolean} whether a credential is loaded. */
  get hasKey() {
    return this.#apiKey !== ''
  }

  /** @returns {string} the base URL without a trailing slash. */
  get baseUrl() {
    return String(this.#config.baseUrl).replace(/\/+$/, '')
  }

  /**
   * Set the account credential.
   * @param {string} key - the upstream API key.
   * @returns {void}
   */
  setApiKey(key) {
    this.#apiKey = typeof key === 'string' ? key.trim() : ''
  }

  /**
   * Set the machine fingerprint once it has been resolved.
   * @param {string} digest - the SHA-256 hex digest.
   * @returns {void}
   */
  setMachine(digest) {
    this.#machine = typeof digest === 'string' ? digest.trim() : ''
  }

  /**
   * Build a full URL for one endpoint path.
   * @param {string} path - an endpoint path such as `/models`.
   * @returns {string} the absolute URL.
   */
  url(path) {
    return `${this.baseUrl}${this.#config.modelBase}${path}`
  }

  /** @returns {Record<string, string>} the header set every request carries. */
  #commonHeaders() {
    /** @type {Record<string, string>} */
    const headers = {
      // These mirror the desktop client's Node fetch exactly; adding a fuller
      // browser-shaped header set moves the request to a substitute backend.
      'User-Agent': this.#config.userAgent,
      Accept: '*/*',
      'Accept-Language': '*',
      'Sec-Fetch-Mode': 'cors',
      'Content-Type': 'application/json',
      [HEADER_LANE]: this.#lane,
      [HEADER_INSTANCE]: this.#instance,
    }
    if (this.#machine !== '') headers[HEADER_MACHINE] = this.#machine
    if (this.#apiKey !== '') headers[HEADER_KEY] = this.#apiKey
    return headers
  }

  /**
   * Convert a non-2xx response into an {@link UpstreamError}.
   * @param {Response} response - the failed response.
   * @param {string} operation - operation name used in the message.
   * @returns {Promise<UpstreamError>} the typed error.
   */
  async #toError(response, operation) {
    const body = await response.text().catch(() => '')
    return new UpstreamError(
      response.status,
      errorCodeOf(body),
      `${operation} failed (HTTP ${String(response.status)})${errorMessageOf(body) === '' ? '' : `: ${errorMessageOf(body)}`}`,
      body,
      retryAfterSeconds(response.headers.get('retry-after')),
    )
  }

  /**
   * Resolve the per-key check-in state.
   * @returns {any} the mutable state record.
   */
  #state() {
    const key = this.#apiKey
    let state = this.#checkIns.get(key)
    if (state === undefined) {
      state = { challenge: undefined, notedAt: 0, attemptedAt: 0, ackedNonce: '', refusedUntil: 0, lastRelay: 0 }
      this.#checkIns.set(key, state)
    }
    return state
  }

  /** Note that a model request is about to be forwarded, for the `pi` beacon field. */
  markRelay() {
    if (this.#apiKey === '') return
    this.#state().lastRelay = Date.now()
  }

  /**
   * Fetch the live model catalog.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<Array<Record<string, unknown>>>} the raw entries.
   * @throws {UpstreamError} on a non-2xx response.
   */
  async listModels(signal) {
    const response = await fetch(this.url(PATH_MODELS), {
      method: 'GET',
      headers: this.#commonHeaders(),
      ...(signal === undefined ? {} : { signal }),
      // An invalid key redirects to the sign-in page; following it would turn an
      // authentication failure into a 200.
      redirect: 'manual',
    })
    if (!response.ok) throw await this.#toError(response, 'model catalog')
    const payload = await response.json()
    const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []
    return list.filter(item => item !== null && typeof item === 'object')
  }

  /**
   * Probe for the lane version upstream currently accepts.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<string>} the lane to use.
   */
  async probeLane(signal) {
    const previous = this.#lane
    for (const lane of laneCandidates(String(this.#config.lane))) {
      this.#lane = lane
      try {
        const response = await fetch(this.url(PATH_MODELS), {
          method: 'GET',
          headers: this.#commonHeaders(),
          ...(signal === undefined ? {} : { signal }),
          redirect: 'manual',
        })
        // A 401 means the lane route was accepted and only the credential is
        // missing, so this candidate is correct.
        if (response.ok || response.status === 401) return lane
        if (response.status !== 426) {
          this.#lane = previous
          return previous
        }
      } catch {
        this.#lane = previous
        return previous
      }
    }
    this.#lane = previous
    return previous
  }

  /**
   * Re-probe the lane behind a cooldown, so a lane bump cannot stampede.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<string>} the lane now in force.
   */
  async revalidateLane(signal) {
    const now = Date.now()
    if (this.#laneCheckedAt > 0 && now - this.#laneCheckedAt < LANE_PROBE_COOLDOWN_MS) return this.#lane
    this.#laneCheckedAt = now
    return this.probeLane(signal)
  }

  /**
   * Build the check-in headers for one `/theos` request.
   * @param {any} state - the per-key check-in state.
   * @returns {Record<string, string>} the extra headers.
   */
  #checkInHeaders(state) {
    /** @type {Record<string, string>} */
    const headers = {}
    const challenge = state.challenge
    const ttl = isValidCheckIn(challenge) ? challenge.seconds : 600
    if (isValidCheckIn(challenge)) headers[HEADER_CHECK_IN] = challenge.nonce
    const relayed = state.lastRelay > 0 && Date.now() - state.lastRelay < ttl * 1000
    const up = Math.max(0, Math.floor((Date.now() - this.#startedAt) / 1000))
    headers[HEADER_BEACON] = `v=${String(this.#config.appVersion)};up=${String(up)};pi=${relayed ? '1' : '0'}`
    return headers
  }

  /**
   * Capture the check-in challenge an upstream body carries.
   * @param {string} body - raw response body of any `/theos` reply.
   * @returns {void}
   */
  #captureChallenge(body) {
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      return
    }
    const raw = parsed?.check_in
    if (raw === null || typeof raw !== 'object') return
    const candidate = { nonce: typeof raw.nonce === 'string' ? raw.nonce.trim() : '', seconds: raw.seconds }
    if (!isValidCheckIn(candidate)) return
    const state = this.#state()
    state.challenge = { nonce: candidate.nonce, seconds: candidate.seconds }
    state.notedAt = Date.now()
  }

  /**
   * Read the daily allowance, completing one check-in round trip as a side effect.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<{balance?: number, granted?: number, refreshAt?: string, laneVersion?: string}>} the allowance.
   * @throws {UpstreamError} on a non-2xx response.
   */
  async theos(signal) {
    if (this.#apiKey === '') throw new UpstreamError(401, CODE_AUTH_REQUIRED, 'no DeepAI Code credential is configured')
    const state = this.#state()
    const headers = { ...this.#commonHeaders(), ...this.#checkInHeaders(state) }
    const sentNonce = headers[HEADER_CHECK_IN] ?? ''

    const response = await fetch(this.url(PATH_THEOS), {
      method: 'GET',
      headers,
      ...(signal === undefined ? {} : { signal }),
      redirect: 'manual',
    })
    const body = await response.text().catch(() => '')

    // Sending a nonce is what completes the check-in, even when the reply is a refusal.
    if (sentNonce !== '') state.ackedNonce = sentNonce
    state.attemptedAt = Date.now()
    this.#captureChallenge(body)

    if (!response.ok) {
      const error = new UpstreamError(
        response.status,
        errorCodeOf(body),
        `Theos query failed (HTTP ${String(response.status)}): ${errorMessageOf(body)}`,
        body,
        retryAfterSeconds(response.headers.get('retry-after')),
      )
      if (error.code === CODE_CHECK_IN_REFUSED) state.refusedUntil = Date.now() + CHECK_IN_REFUSED_LOCK_MS
      throw error
    }

    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      throw new UpstreamError(response.status, 'MALFORMED_RESPONSE', 'the Theos response is not JSON', body)
    }

    const allowance = {}
    const balance = numberOrUndefined(payload?.balance ?? payload?.remaining)
    if (balance !== undefined) allowance.balance = balance
    const granted = numberOrUndefined(payload?.granted ?? payload?.allowance ?? payload?.limit)
    if (granted !== undefined) allowance.granted = granted
    const refreshAt = payload?.refresh_at ?? payload?.refreshAt
    if (typeof refreshAt === 'string' && refreshAt !== '') allowance.refreshAt = refreshAt
    const laneVersion = payload?.lane_version ?? payload?.laneVersion
    if (typeof laneVersion === 'string' && laneVersion !== '') allowance.laneVersion = laneVersion
    return allowance
  }

  /**
   * Make sure the check-in cycle is current before a model call.
   * Failures are swallowed: a missing check-in degrades routing, it must not
   * block inference.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<{balance?: number, granted?: number} | undefined>} the allowance when it was read.
   */
  async ensureCheckIn(signal) {
    if (this.#apiKey === '') return undefined
    const state = this.#state()
    const now = Date.now()
    if (state.refusedUntil > 0 && now < state.refusedUntil) return undefined

    const challenge = state.challenge
    const hasChallenge = isValidCheckIn(challenge)
    const needsAck = hasChallenge && challenge.nonce !== state.ackedNonce
    if (hasChallenge && !needsAck && now - state.notedAt < (challenge.seconds * 1000) / 2) {
      return { balance: undefined, granted: undefined }
    }
    if (state.attemptedAt > 0 && now - state.attemptedAt < CHECK_IN_MIN_INTERVAL_MS) return undefined

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CHECK_IN_TIMEOUT_MS)
    try {
      return await this.theos(signal ?? controller.signal)
    } catch (error) {
      this.#logger?.warn('deepaicode: check-in did not complete', error)
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Combine the caller's signal with the configured request deadline.
   * @param {AbortSignal} [signal] - the caller's cancellation.
   * @returns {AbortSignal | undefined} a signal that also aborts on timeout.
   */
  #withDeadline(signal) {
    const timeout = Number.isFinite(this.#config.requestTimeoutMs) && this.#config.requestTimeoutMs > 0
      ? this.#config.requestTimeoutMs
      : 0
    if (timeout === 0) return signal
    const deadline = AbortSignal.timeout(timeout)
    return signal === undefined ? deadline : AbortSignal.any([signal, deadline])
  }

  /**
   * Open one streaming model call, applying the shape fallback and the lane
   * re-probe only when upstream asks for them.
   * @param {object} options - the adapter's generate options.
   * @param {{model: string, api: string}} target - the wire model and endpoint family.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<{body: ReadableStream<Uint8Array>, status: number}>} the SSE body.
   * @throws {UpstreamError} when no attempt succeeded.
   */
  async openStream(options, target, signal) {
    // Upstream splits its models across two endpoints and a model served by one
    // is refused by the other, so the endpoint family comes from the catalog.
    const isResponses = target.api === 'openai-responses'
    const path = isResponses ? PATH_RESPONSES : PATH_CHAT
    const body = isResponses ? buildResponsesBody(options, target.model) : buildChatBody(options, target.model)
    const affinity = !isResponses && typeof body.prompt_cache_key === 'string' ? body.prompt_cache_key : ''
    // A hung upstream connection must not hold a turn open forever; the
    // deadline bounds connection setup only, because the body streams long
    // after the response headers arrived.
    const connectSignal = this.#withDeadline(signal)
    const post = async (payload) => {
      this.markRelay()
      const headers = this.#commonHeaders()
      if (/^[A-Za-z0-9._:-]{1,256}$/.test(affinity)) headers[HEADER_AFFINITY] = affinity
      return fetch(this.url(path), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        ...(connectSignal === undefined ? {} : { signal: connectSignal }),
        redirect: 'manual',
      })
    }

    let response = await post(body)
    if (response.ok) return this.#toResult(response)

    const error = await this.#toError(response, `model ${target.model}`)

    if (error.bodyRejected && !isResponses) {
      const corrected = chatBodyFallback(body, options.system)
      if (corrected !== undefined) {
        response = await post(corrected)
        if (response.ok) {
          this.#logger?.warn(`deepaicode: ${target.model} required the desktop request shape`)
          return this.#toResult(response)
        }
        throw await this.#toError(response, `model ${target.model} after the shape fallback`)
      }
    }

    if (error.laneUnsupported) {
      const before = this.#lane
      await this.revalidateLane(signal).catch(() => before)
      if (this.#lane !== before) {
        response = await post(body)
        if (response.ok) return this.#toResult(response)
        throw await this.#toError(response, `model ${target.model} after the lane re-probe`)
      }
    }

    throw error
  }

  /**
   * Check that a successful response actually carries a stream.
   * @param {Response} response - the successful response.
   * @returns {{body: ReadableStream<Uint8Array>, status: number}} the body handle.
   */
  #toResult(response) {
    if (response.body === null) {
      throw new UpstreamError(response.status, 'MALFORMED_RESPONSE', 'the upstream response carried no body')
    }
    return { body: response.body, status: response.status }
  }
}

/**
 * Coerce a numeric field that upstream may send as a decimal string.
 * @param {unknown} value - raw candidate.
 * @returns {number | undefined} the number, when it is one.
 */
function numberOrUndefined(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}
