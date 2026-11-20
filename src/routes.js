/**
 * Host HTTP routes backing the DeepAI Code settings page.
 *
 * The browser half is served from the same origin as the Web GUI, so it talks
 * to these routes with plain relative `fetch`. Security has one home: every
 * route asks the composition's `connection` service for a rejection first, so
 * the Host/Origin fence and the browser authentication cookie gate every caller
 * before any status, sign-in, or credential write is reachable. Past that fence
 * each route validates its own body at the wire.
 *
 * @module dsh-deepaicode-auto/routes
 */

/** Routes served by this plugin, in their absolute (Host) form. */
export const DEEPAICODE_ROUTES = Object.freeze({
  status: '/deepaicode/status',
  signIn: '/deepaicode/sign-in',
  apiKey: '/deepaicode/api-key',
  signOut: '/deepaicode/sign-out',
  refresh: '/deepaicode/refresh',
})

/** The browser addresses routes relative to the document, so the leading slash is dropped. */
export const DEEPAICODE_BROWSER_ROUTES = Object.freeze(
  Object.fromEntries(Object.entries(DEEPAICODE_ROUTES).map(([key, path]) => [key, path.slice(1)])),
)

/** Request bodies here are a few hundred bytes; anything large is hostile. */
const MAX_BODY_BYTES = 16 * 1024

/**
 * Send one JSON response.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - JSON-serializable body.
 * @returns {void}
 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Send a refusal with a machine code and a human message.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {string} code - stable failure code.
 * @param {string} message - human-readable explanation.
 * @returns {void}
 */
function sendFailure(res, status, code, message) {
  sendJson(res, status, { code, message })
}

/**
 * Read a bounded JSON request body.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<{ok: true, value: unknown} | {ok: false, status: number, code: string, message: string}>} the parsed body or a refusal.
 */
async function readJsonBody(req) {
  const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
  if (essence !== 'application/json') {
    return { ok: false, status: 415, code: 'unsupported-media-type', message: 'content-type must be application/json' }
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      req.resume()
      return { ok: false, status: 413, code: 'payload-too-large', message: 'request body is too large' }
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks, size).toString('utf8')
  if (text.trim() === '') return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, status: 400, code: 'bad-request', message: 'request body must be JSON' }
  }
}

/**
 * Register the settings routes on the composition's web server.
 *
 * Absent `webServer` or `connection` services leave the plugin without a
 * settings page but never without a model provider, so a headless profile keeps
 * working.
 *
 * @param {any} ctx - the plugin context.
 * @param {import('./connection.js').ConnectionController} controller - the connection controller.
 * @param {{info: Function, warn: Function, debug: Function}} logger - diagnostics sink.
 * @returns {boolean} whether the routes were registered.
 */
export function registerDeepAiCodeRoutes(ctx, controller, logger) {
  const webServer = ctx.get('webServer')
  const connection = ctx.get('connection')
  if (webServer === undefined || typeof webServer.register !== 'function') return false
  if (connection === undefined || typeof connection.requestRejection !== 'function') {
    logger.warn('deepaicode: no connection trust fence is mounted, so the settings page stays off')
    return false
  }

  /**
   * Apply the composition's trust fence before any business logic.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @returns {boolean} true when the request was already refused.
   */
  const rejected = (req, res) => {
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  /**
   * Register one route under the plugin's effect lifetime.
   * @param {string} path - absolute route path.
   * @param {(req: any, res: any) => Promise<void> | void} handler - the handler.
   * @returns {void}
   */
  const register = (path, handler) => {
    ctx.effect(() => webServer.register({ kind: 'exact', path, handler }), `deepaicode: route ${path}`)
  }

  register(DEEPAICODE_ROUTES.status, (req, res) => {
    if (rejected(req, res)) return
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET')
      sendFailure(res, 405, 'method-not-allowed', 'only GET is accepted')
      return
    }
    sendJson(res, 200, controller.status())
  })

  register(DEEPAICODE_ROUTES.signIn, async (req, res) => {
    if (rejected(req, res)) return
    if (req.method === 'DELETE') {
      sendJson(res, 200, controller.cancelSignIn())
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST, DELETE')
      sendFailure(res, 405, 'method-not-allowed', 'only POST and DELETE are accepted')
      return
    }
    try {
      sendJson(res, 200, await controller.beginSignIn())
    } catch (error) {
      sendFailure(res, 502, 'sign-in-unavailable', error instanceof Error ? error.message : String(error))
    }
  })

  register(DEEPAICODE_ROUTES.apiKey, async (req, res) => {
    if (rejected(req, res)) return
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendFailure(res, 405, 'method-not-allowed', 'only POST is accepted')
      return
    }
    const body = await readJsonBody(req)
    if (body.ok === false) {
      sendFailure(res, body.status, body.code, body.message)
      return
    }
    const value = body.value !== null && typeof body.value === 'object' ? body.value.apiKey : undefined
    try {
      sendJson(res, 200, await controller.connectWithKey(value))
    } catch (error) {
      sendFailure(res, 400, 'invalid-key', error instanceof Error ? error.message : String(error))
    }
  })

  register(DEEPAICODE_ROUTES.signOut, async (req, res) => {
    if (rejected(req, res)) return
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendFailure(res, 405, 'method-not-allowed', 'only POST is accepted')
      return
    }
    sendJson(res, 200, await controller.signOut())
  })

  register(DEEPAICODE_ROUTES.refresh, async (req, res) => {
    if (rejected(req, res)) return
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendFailure(res, 405, 'method-not-allowed', 'only POST is accepted')
      return
    }
    sendJson(res, 200, await controller.refresh())
  })

  return true
}
