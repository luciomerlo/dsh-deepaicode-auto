/**
 * Local browser sign-in (RFC 8252) and credential storage.
 *
 * The desktop client obtains its `Api-Key` through a loopback redirect: the
 * plugin opens the DeepAI sign-in page with its `state` and a free local port,
 * the browser posts the authorization code back to `127.0.0.1`, and the code is
 * exchanged for the account key. Nothing depends on the desktop app being
 * installed.
 *
 * @module dsh-deepaicode-auto/auth
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** How long one sign-in attempt stays open. */
const LOGIN_TTL_MS = 10 * 60 * 1000

/** Callback path the sign-in page redirects to. */
const CALLBACK_PATH = '/auth-callback'

/**
 * @typedef {object} StoredAccount
 * @property {string} apiKey - the upstream `Api-Key`.
 * @property {string} username - the account name, for display only.
 * @property {boolean} isPro - whether the account reports a paid plan.
 * @property {string} obtainedAt - ISO timestamp of the exchange.
 */

/**
 * Resolve the plugin's private data directory.
 * @param {string} [home] - override for the DSH home directory.
 * @returns {string} absolute directory path.
 */
export function dataDir(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  return join(home, 'deepaicode')
}

/**
 * File-backed store for the account credential.
 *
 * The file is written with owner-only permissions outside the profile, so a
 * profile reset or migration does not discard the sign-in.
 */
export class AccountStore {
  /** @type {string} */
  #path
  /** @type {StoredAccount | undefined} */
  #account
  #loaded = false

  /**
   * @param {string} [directory] - directory holding `account.json`.
   */
  constructor(directory = dataDir()) {
    this.#path = join(directory, 'account.json')
  }

  /** @returns {string} the credential file path. */
  get path() {
    return this.#path
  }

  /**
   * Load the stored account, if any. A missing or malformed file means signed out.
   * @returns {Promise<void>} resolves once loaded.
   */
  async load() {
    if (this.#loaded) return
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8'))
      if (typeof parsed?.apiKey === 'string' && parsed.apiKey.trim() !== '') {
        this.#account = {
          apiKey: parsed.apiKey.trim(),
          username: typeof parsed.username === 'string' ? parsed.username : '',
          isPro: parsed.isPro === true,
          obtainedAt: typeof parsed.obtainedAt === 'string' ? parsed.obtainedAt : '',
        }
      }
    } catch {
      // Signed out.
    }
    this.#loaded = true
  }

  /** @returns {StoredAccount | undefined} the account, after {@link load}. */
  get() {
    return this.#account
  }

  /** @returns {boolean} whether a credential is stored. */
  get signedIn() {
    return this.#account !== undefined
  }

  /**
   * Persist one account atomically.
   * @param {StoredAccount} account - the account to store.
   * @returns {Promise<void>} resolves once written.
   */
  async save(account) {
    await mkdir(dirname(this.#path), { recursive: true })
    const temporary = `${this.#path}.${String(process.pid)}.tmp`
    await writeFile(temporary, `${JSON.stringify(account, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.#path)
    await chmod(this.#path, 0o600).catch(() => {})
    this.#account = account
    this.#loaded = true
  }

  /**
   * Forget the stored credential.
   * @returns {Promise<void>} resolves once removed.
   */
  async clear() {
    this.#account = undefined
    this.#loaded = true
    await rm(this.#path, { force: true }).catch(() => {})
  }
}

/**
 * Compare two strings without leaking their common prefix length.
 * @param {string} a - first value.
 * @param {string} b - second value.
 * @returns {boolean} whether they are equal.
 */
function safeEqual(a, b) {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Exchange an authorization code for the account key.
 * @param {string} baseUrl - the upstream origin.
 * @param {string} modelBase - the model endpoint prefix, such as `/deepai_code`.
 * @param {string} code - the authorization code from the callback.
 * @param {string} userAgent - the user agent to present.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<StoredAccount>} the authorized account.
 */
export async function exchangeCode(baseUrl, modelBase, code, userAgent, signal) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${modelBase}/desktop_auth/exchange/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': userAgent,
      Accept: '*/*',
      'Accept-Language': '*',
      'Sec-Fetch-Mode': 'cors',
    },
    body: JSON.stringify({ code }),
    ...(signal === undefined ? {} : { signal }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`DeepAI rejected the authorization code (HTTP ${String(response.status)}): ${text.slice(0, 300)}`)

  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`the sign-in exchange returned no JSON: ${text.slice(0, 200)}`)
  }
  const apiKey = typeof payload?.api_key === 'string' ? payload.api_key : typeof payload?.key === 'string' ? payload.key : ''
  if (apiKey.trim() === '') throw new Error('the sign-in exchange returned no API key')

  return {
    apiKey: apiKey.trim(),
    username: typeof payload?.username === 'string' ? payload.username : '',
    isPro: payload?.is_pro === true,
    obtainedAt: new Date().toISOString(),
  }
}

/**
 * @typedef {object} SignInSession
 * @property {() => Promise<string>} ready - resolves to the URL the human must open.
 * @property {() => Promise<StoredAccount>} wait - resolves once the callback completed.
 * @property {() => void} cancel - abandons the attempt and closes the loopback server.
 * @property {number} state - the CSRF state, for diagnostics.
 */

/**
 * Start one loopback sign-in attempt.
 * @param {object} options - attempt wiring.
 * @param {string} options.baseUrl - the upstream origin.
 * @param {string} options.modelBase - the model endpoint prefix.
 * @param {string} [options.userAgent] - user agent to present.
 * @returns {SignInSession} the attempt handle.
 */
export function startSignIn(options) {
  // The upstream sign-in page rejects a short `state`, so this is a 64-character
  // lower-case hex nonce rather than the usual 16-byte state.
  const state = randomBytes(32).toString('hex')
  const userAgent = options.userAgent ?? 'node'
  /** @type {import('node:http').Server | undefined} */
  let server
  let finished = false
  /** @type {NodeJS.Timeout | undefined} */
  let timer
  let settle = () => {}
  let fail = () => {}

  const done = new Promise((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  // A caller may start an attempt and never await it; keep that rejection quiet.
  done.catch(() => {})

  const finish = (fn) => {
    if (finished) return
    finished = true
    if (timer !== undefined) clearTimeout(timer)
    try {
      server?.close()
    } catch {
      // Already closed.
    }
    fn()
  }

  const pendingPort = new Promise((resolve, reject) => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end('Not found')
        return
      }
      const code = url.searchParams.get('code') ?? ''
      const gotState = url.searchParams.get('state') ?? ''
      if (request.method !== 'GET' || code === '' || code.length > 4096 || !safeEqual(gotState, state)) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Invalid sign-in callback.')
        return
      }
      void exchangeCode(options.baseUrl, options.modelBase, code, userAgent)
        .then(account => {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
            .end('<h2>DeepAI Code authorized</h2><p>You can close this tab and return to DeepSeek Harness.</p>')
          finish(() => settle(account))
        })
        .catch(error => {
          response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
            .end('Sign-in failed. Return to DeepSeek Harness and try again.')
          finish(() => fail(error instanceof Error ? error : new Error(String(error))))
        })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server?.address()
      if (typeof address === 'object' && address !== null) resolve(address.port)
      else reject(new Error('the loopback callback could not bind a port'))
    })
  })

  timer = setTimeout(() => finish(() => fail(new Error('sign-in timed out after 10 minutes'))), LOGIN_TTL_MS)
  timer.unref?.()

  return {
    state,
    ready: () => pendingPort.then(port => {
      const target = new URL(`${options.baseUrl.replace(/\/+$/, '')}${options.modelBase}/desktop_auth/`)
      target.searchParams.set('state', state)
      target.searchParams.set('port', String(port))
      return target.toString()
    }),
    wait: () => done,
    cancel: () => finish(() => fail(new Error('sign-in cancelled'))),
  }
}
