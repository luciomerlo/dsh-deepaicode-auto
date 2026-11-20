/**
 * Connection controller for the DeepAI Code settings section.
 *
 * Owns the interactive half of authentication — begin a browser sign-in, report
 * its progress, accept a pasted key, sign out — and publishes one status object
 * the settings page renders. The controller holds no HTTP knowledge, so the
 * routes and the unit tests drive exactly the same methods.
 *
 * @module dsh-deepaicode-auto/connection
 */

import { startSignIn } from './auth.js'

/** States a sign-in attempt moves through. */
export const SIGN_IN_IDLE = 'idle'
export const SIGN_IN_PENDING = 'pending'
export const SIGN_IN_CONNECTED = 'connected'
export const SIGN_IN_FAILED = 'failed'

/** A DeepAI account key is a UUID. */
const KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Whether a string is shaped like a DeepAI account key.
 * @param {unknown} value - candidate credential.
 * @returns {boolean} true when it is a UUID.
 */
export function looksLikeApiKey(value) {
  return typeof value === 'string' && KEY_PATTERN.test(value.trim())
}

/**
 * One connection controller per mounted plugin.
 *
 * The credential can come from five places, and only some of them are the
 * user's to change from this page: a key in the loader config or the process
 * environment outranks anything written here, so the status reports its source
 * and signing out explains itself instead of silently doing nothing.
 */
export class ConnectionController {
  #client
  #catalog
  #router
  #store
  #config
  #logger
  /** @type {'config' | 'environment' | 'store' | 'desktop' | 'none'} */
  #source = 'none'
  /** @type {any} */
  #signIn
  /** @type {{balance?: number, granted?: number, refreshAt?: string, at: number} | undefined} */
  #allowance
  /** @type {string | undefined} */
  #lastError

  /**
   * @param {object} parts - collaborators.
   * @param {import('./client.js').DeepAiClient} parts.client - upstream client.
   * @param {import('./catalog.js').ModelCatalog} parts.catalog - model catalog.
   * @param {import('./router.js').AutoRouter} parts.router - routing policy.
   * @param {import('./auth.js').AccountStore} parts.store - credential store.
   * @param {Record<string, any>} parts.config - resolved plugin config.
   * @param {{info: Function, warn: Function, debug: Function}} parts.logger - diagnostics sink.
   */
  constructor(parts) {
    this.#client = parts.client
    this.#catalog = parts.catalog
    this.#router = parts.router
    this.#store = parts.store
    this.#config = parts.config
    this.#logger = parts.logger
  }

  /**
   * Record where the active credential came from, for the settings page.
   * @param {'config' | 'environment' | 'store' | 'desktop' | 'none'} source - the winning source.
   * @returns {void}
   */
  setCredentialSource(source) {
    this.#source = source
  }

  /** @returns {string} the winning credential source. */
  get credentialSource() {
    return this.#source
  }

  /**
   * Publish the allowance a caller just read, so status stays network-free.
   * @param {{balance?: number, granted?: number, refreshAt?: string} | undefined} allowance - reported values.
   * @returns {void}
   */
  setAllowance(allowance) {
    if (allowance === undefined) return
    this.#allowance = { ...allowance, at: Date.now() }
  }

  /**
   * Publish the last failure so the page can explain a broken connection.
   * @param {unknown} error - the failure, or undefined to clear it.
   * @returns {void}
   */
  setError(error) {
    this.#lastError = error === undefined ? undefined : messageOf(error)
  }

  /**
   * The public, network-free status snapshot.
   * @returns {object} the status the settings page renders.
   */
  status() {
    const snapshot = this.#router.snapshot()
    const allowance = this.#allowance
    return {
      signedIn: this.#client.hasKey,
      credentialSource: this.#source,
      username: this.#signIn?.account?.username ?? '',
      provider: { id: 'deepaicode', name: 'DeepAI Code', lane: this.#client.lane, baseUrl: this.#client.baseUrl },
      catalog: {
        count: this.#catalog.list().size,
        live: this.#catalog.live,
        ageMs: this.#catalog.fetchedAt === 0 ? null : Date.now() - this.#catalog.fetchedAt,
      },
      allowance: allowance === undefined
        ? null
        : {
          balance: allowance.balance ?? null,
          granted: allowance.granted ?? null,
          refreshAt: allowance.refreshAt ?? null,
          ageMs: Date.now() - allowance.at,
        },
      router: {
        remainingTheos: snapshot.remainingTheos,
        budget: snapshot.budget,
        frontierReady: snapshot.frontierReady.length,
        unmeteredReady: snapshot.unmeteredReady.length,
        exhausted: snapshot.exhausted,
        recentHandoffs: snapshot.recentHandoffs.slice(-5),
      },
      signIn: this.#signInPublic(),
      error: this.#lastError ?? null,
    }
  }

  /**
   * Public view of the current sign-in attempt.
   * @returns {{state: string, url?: string, error?: string}} the attempt state.
   */
  #signInPublic() {
    const record = this.#signIn
    if (record === undefined) return { state: SIGN_IN_IDLE }
    const view = { state: record.state }
    if (record.url !== undefined && record.state !== SIGN_IN_CONNECTED) view.url = record.url
    if (record.error !== undefined) view.error = record.error
    return view
  }

  /**
   * Begin a browser sign-in, or return the attempt already in flight.
   * @returns {Promise<{state: string, url?: string}>} the attempt state, including the URL to open.
   */
  async beginSignIn() {
    if (this.#signIn !== undefined && this.#signIn.state === SIGN_IN_PENDING) return this.#signInPublic()

    const session = startSignIn({
      baseUrl: this.#config.baseUrl,
      modelBase: this.#config.modelBase,
      userAgent: this.#config.userAgent,
    })
    /** @type {any} */
    const record = { session, state: SIGN_IN_PENDING, url: undefined, error: undefined, account: undefined }
    this.#signIn = record
    record.url = await session.ready()

    session.wait().then(async account => {
      record.state = SIGN_IN_CONNECTED
      record.account = account
      this.#client.setApiKey(account.apiKey)
      await this.#store.save(account)
      this.#logger.info('deepaicode: signed in from the settings page')
      await this.refresh().catch(() => {})
    }, error => {
      record.state = SIGN_IN_FAILED
      record.error = messageOf(error)
      this.#logger.warn('deepaicode: the settings sign-in did not complete', error)
    })

    return this.#signInPublic()
  }

  /**
   * Abandon a pending sign-in attempt.
   * @returns {{state: string}} the resulting state.
   */
  cancelSignIn() {
    if (this.#signIn !== undefined && this.#signIn.state === SIGN_IN_PENDING) {
      this.#signIn.session.cancel()
      this.#signIn = undefined
    }
    return { state: SIGN_IN_IDLE }
  }

  /**
   * Accept a pasted account key after proving it works upstream.
   * @param {unknown} value - the candidate key.
   * @returns {Promise<object>} the refreshed status.
   * @throws {Error} when the key is malformed or the provider refuses it.
   */
  async connectWithKey(value) {
    const key = typeof value === 'string' ? value.trim() : ''
    if (!looksLikeApiKey(key)) throw new Error('An API key is a 36-character UUID.')
    this.#client.setApiKey(key)
    let allowance
    try {
      allowance = await this.#client.theos()
    } catch (error) {
      this.#client.setApiKey('')
      throw new Error(`DeepAI rejected this key: ${messageOf(error)}`)
    }
    await this.#store.save({ apiKey: key, username: '', isPro: false, obtainedAt: new Date().toISOString() })
    this.setCredentialSource('store')
    this.setError(undefined)
    this.setAllowance(allowance)
    this.#signIn = undefined
    await this.#catalog.refresh({ force: true }).catch(() => {})
    return this.status()
  }

  /**
   * Forget the stored credential.
   * @returns {Promise<object>} the refreshed status, whose source reports whether a higher layer still supplies a key.
   */
  async signOut() {
    await this.#store.clear()
    this.#allowance = undefined
    this.#signIn = undefined
    const configured = typeof this.#config.apiKey === 'string' ? this.#config.apiKey.trim() : ''
    const fromEnvironment = (process.env.DEEPAI_CODE_API_KEY ?? process.env.DEEPAI_API_KEY ?? '').trim()
    if (configured !== '') {
      this.#client.setApiKey(configured)
      this.#source = 'config'
    } else if (fromEnvironment !== '') {
      this.#client.setApiKey(fromEnvironment)
      this.#source = 'environment'
    } else {
      this.#client.setApiKey('')
      this.#source = 'none'
    }
    return this.status()
  }

  /**
   * Re-read the live catalog and the daily allowance.
   * @returns {Promise<object>} the refreshed status.
   */
  async refresh() {
    await this.#catalog.refresh({ force: true }).catch(error => {
      this.#logger.warn('deepaicode: catalog refresh failed', error)
    })
    if (!this.#client.hasKey) return this.status()
    try {
      const allowance = await this.#client.theos()
      this.setAllowance(allowance)
      this.setError(undefined)
    } catch (error) {
      this.setError(error)
    }
    return this.status()
  }
}

/**
 * Read a human-readable message out of a thrown value.
 * @param {unknown} error - the thrown value.
 * @returns {string} a non-empty message.
 */
function messageOf(error) {
  if (error instanceof Error && error.message !== '') return error.message
  const message = String(error)
  return message === '' ? 'unknown error' : message
}
