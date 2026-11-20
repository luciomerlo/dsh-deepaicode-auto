/**
 * DeepAI Code provider for DeepSeek Harness.
 *
 * Registers one `llm` provider route (`deepaicode`) whose catalog is the live
 * DeepAI Code model list and whose virtual `auto` model routes every request
 * through the Frontier -> Unmetered ladder with hot failover.
 *
 * The plugin imports nothing from `@deepseek-ai/*`: the `llm` service validates
 * an adapter through `providerInfo`/`providerRetryPolicy` only, so a plain
 * object satisfies the contract and the bundle cannot bind to the wrong harness
 * build. See README.md for the credential sources and the routing rules.
 *
 * @module dsh-deepaicode-auto
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { AccountStore } from './src/auth.js'
import { ModelCatalog } from './src/catalog.js'
import { DeepAiClient } from './src/client.js'
import { createAdapter, PROVIDER_ID } from './src/adapter.js'
import { ConnectionController } from './src/connection.js'
import { resolveMachineDigest } from './src/identity.js'
import { AutoRouter } from './src/router.js'
import { registerDeepAiCodeRoutes } from './src/routes.js'
import { createFreeModelsTool, registerFreeModelsTool } from './src/tools.js'
import { FreeModelVerifier, VERIFY_INTERVAL_MS } from './src/verify.js'

export const name = 'deepaicode-auto'
export const inject = ['llm']

/** Default plugin configuration; every key is overridable from the profile patch. */
const DEFAULTS = {
  baseUrl: 'https://api.deepai.org',
  modelBase: '/deepai_code',
  lane: 7,
  appVersion: '0.3.42',
  userAgent: 'node',
  apiKey: '',
  autoModelId: 'auto',
  autoModelName: 'Auto (DeepAiCode)',
  dailyTheosBudget: 250,
  maxFailovers: 8,
  refreshCatalogOnError: true,
  autoSignIn: false,
  failoverExplicitModels: false,
  requestTimeoutMs: 180_000,
  streamIdleTimeoutMs: 90_000,
  verifyFreeModelsEveryMs: VERIFY_INTERVAL_MS,
  machineId: '',
  frontier: undefined,
  unmetered: undefined,
}

/**
 * Merge the row config over the defaults.
 * @param {Record<string, unknown> | undefined} input - the loader row config.
 * @returns {Record<string, any>} the resolved config.
 */
export function resolveConfig(input) {
  const config = { ...DEFAULTS, ...(input ?? {}) }
  const errors = []
  if (typeof config.baseUrl !== 'string' || config.baseUrl.trim() === '') errors.push('baseUrl must be a non-empty URL')
  if (!Number.isInteger(config.lane) || config.lane < 1) errors.push('lane must be a positive integer')
  if (!Number.isInteger(config.dailyTheosBudget) || config.dailyTheosBudget < 1) errors.push('dailyTheosBudget must be a positive integer')
  if (!Number.isInteger(config.maxFailovers) || config.maxFailovers < 1) errors.push('maxFailovers must be a positive integer')
  if (typeof config.autoModelId !== 'string' || config.autoModelId.trim() === '') errors.push('autoModelId must be a non-empty string')
  if (config.frontier !== undefined && !Array.isArray(config.frontier)) errors.push('frontier must be a list')
  if (config.unmetered !== undefined && !Array.isArray(config.unmetered)) errors.push('unmetered must be a list')
  if (errors.length > 0) throw new Error(`deepaicode-auto: invalid config — ${errors.join('; ')}`)
  return config
}

/**
 * Read the credential the official desktop app stored, when it is present and readable.
 *
 * The desktop client keeps its account as plain JSON in its own user data
 * directory, so an already signed-in machine needs no second sign-in.
 * @returns {Promise<string | undefined>} the stored API key, when one is found.
 */
async function readDesktopCredential() {
  const candidates = [
    join(homedir(), '.deepai-code', 'userdata', 'secrets', 'deepai-account.bin'),
    join(process.env.APPDATA ?? '', 'DeepAI Code', 'userdata', 'secrets', 'deepai-account.bin'),
  ]
  for (const candidate of candidates) {
    if (candidate === '') continue
    try {
      const parsed = JSON.parse(await readFile(candidate, 'utf8'))
      const key = typeof parsed?.apiKey === 'string' ? parsed.apiKey.trim() : ''
      if (key !== '') return key
    } catch {
      // Not there, or not readable: the next source applies.
    }
  }
  return undefined
}

/**
 * Open a URL in the platform browser without blocking startup.
 * @param {string} url - the URL to open.
 * @param {{warn: Function}} logger - diagnostics sink.
 * @returns {void}
 */
function openBrowser(url, logger) {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    execFile(command, args, { windowsHide: true }, error => {
      if (error) logger.warn('deepaicode: could not open a browser; open this URL manually:', url)
    })
  } catch {
    logger.warn('deepaicode: could not open a browser; open this URL manually:', url)
  }
}

/**
 * Mount the DeepAI Code provider.
 * @param {any} ctx - the plugin context.
 * @param {Record<string, unknown>} [input] - the loader row config.
 * @returns {void}
 */
export function apply(ctx, input) {
  const config = resolveConfig(input)
  const logger = {
    info: (...args) => ctx.logger?.info?.(...args),
    warn: (...args) => ctx.logger?.warn?.(...args),
    debug: (...args) => ctx.logger?.debug?.(...args),
  }

  const store = new AccountStore()
  const client = new DeepAiClient({ config, logger })
  const catalog = new ModelCatalog({
    fetchModels: signal => client.listModels(signal),
    logger,
  })
  const router = new AutoRouter({ budget: config.dailyTheosBudget, maxFailovers: config.maxFailovers })
  const adapter = createAdapter({ router, client, catalog, config, logger })

  const registration = ctx.llm.registerAdapter([PROVIDER_ID], adapter)
  if (registration === undefined || typeof registration !== 'function') {
    throw new Error('deepaicode-auto: the llm service refused the adapter registration')
  }

  // The free model tier is re-established rather than remembered: one daily
  // read of the catalog decides which models cost nothing now.
  const verifier = new FreeModelVerifier({
    catalog,
    config,
    logger,
    rebuild: () => adapter.syncCatalog(),
  })

  // The connection controller owns every interactive authentication step, and
  // the settings routes are its only caller. Both stay optional: a headless
  // profile has no Web server and keeps its model provider regardless.
  const controller = new ConnectionController({ client, catalog, router, store, config, logger, verifier })
  const routesMounted = registerDeepAiCodeRoutes(ctx, controller, logger)
  const toolMounted = registerFreeModelsTool(ctx, createFreeModelsTool({ verifier }), logger)

  /**
   * Resolve the credential from config, environment, the plugin store, or the
   * desktop app; start a browser sign-in only when the profile asked for one.
   * @returns {Promise<void>} resolves once an attempt has been made.
   */
  async function resolveCredential() {
    const configured = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
    if (configured !== '') {
      client.setApiKey(configured)
      controller.setCredentialSource('config')
      return
    }
    const fromEnvironment = (process.env.DEEPAI_CODE_API_KEY ?? process.env.DEEPAI_API_KEY ?? '').trim()
    if (fromEnvironment !== '') {
      client.setApiKey(fromEnvironment)
      controller.setCredentialSource('environment')
      return
    }
    await store.load()
    const stored = store.get()
    if (stored !== undefined) {
      client.setApiKey(stored.apiKey)
      controller.setCredentialSource('store')
      return
    }
    const desktop = await readDesktopCredential()
    if (desktop !== undefined) {
      client.setApiKey(desktop)
      controller.setCredentialSource('desktop')
      await store.save({ apiKey: desktop, username: '', isPro: false, obtainedAt: new Date().toISOString() }).catch(() => {})
      logger.info('deepaicode: reused the DeepAI Code desktop sign-in')
      return
    }
    if (config.autoSignIn !== true) {
      logger.warn('deepaicode: no DeepAI Code credential yet — connect from Settings → DeepAI Code, or set DEEPAI_CODE_API_KEY')
      return
    }

    // autoSignIn exists for profiles that have no settings page at all. The
    // attempt still goes through the controller, so an open settings page
    // follows the sign-in it did not start.
    try {
      const attempt = await controller.beginSignIn()
      if (attempt.url !== undefined) {
        logger.info(`deepaicode: sign in to DeepAI Code here — ${attempt.url}`)
        openBrowser(attempt.url, logger)
      }
    } catch (error) {
      logger.warn('deepaicode: the local sign-in callback could not start', error)
    }
  }

  // Startup work runs inside one effect so the plugin's lifetime owns it: the
  // catalog read, the free-model verification and the allowance probe are
  // exactly the "on every start" behaviour the routing contract promises.
  const lifetime = new AbortController()
  ctx.effect(() => {
    void (async () => {
      try {
        client.setMachine(await resolveMachineDigest({ override: config.machineId, logger }))
        // start() hydrates the persisted report first, so the first diff of this
        // session compares against the last real check instead of reporting
        // every free model as new.
        await verifier.start()
        await resolveCredential()
        if (!client.hasKey()) {
          await verifier.verify({ force: true }).catch(() => {})
          logger.warn('deepaicode: the free-model tier stays on the published table until an account is connected')
          return
        }
        const lane = await client.revalidateLane(lifetime.signal).catch(() => client.lane)
        logger.info(`deepaicode: lane ${lane}, provider "${PROVIDER_ID}" ready`)
        const verification = await verifier.verify({ force: true })
        try {
          const allowance = await client.ensureCheckIn(lifetime.signal)
          if (allowance !== undefined && (typeof allowance.balance === 'number' || typeof allowance.granted === 'number')) {
            router.setQuota(allowance.balance ?? null, allowance.granted)
            controller.setAllowance(allowance)
            logger.info(`deepaicode: ${String(allowance.balance)} of ${String(allowance.granted)} Theos left today`)
          }
        } catch (error) {
          controller.setError(error)
          logger.warn('deepaicode: the allowance probe failed at startup', error)
        }
        logger.info(
          `deepaicode: ${String(catalog.list().size)} models (${catalog.live ? 'live catalog' : 'published fallback'}), `
          + `${String(verification.freeCount)} free (verified ${verification.verified ? 'live' : 'from the published table'}), `
          + `${config.autoModelName} routes Frontier models first`
          + `${routesMounted ? '; settings page mounted at Settings → DeepAI Code' : ''}`
          + `${toolMounted ? `; tool ${'deepaicode_free_models'} mounted` : ''}`,
        )
      } catch (error) {
        controller.setError(error)
        logger.warn('deepaicode: startup failed', error)
      }
    })()
    return () => {
      lifetime.abort()
      verifier.stop()
      if (typeof registration === 'function') registration()
    }
  }, 'deepaicode-auto: provider registration lifetime')
}

export { PROVIDER_ID }
