import test from 'node:test'
import assert from 'node:assert/strict'

import { ConnectionController, looksLikeApiKey, SIGN_IN_CONNECTED, SIGN_IN_IDLE, SIGN_IN_PENDING } from '../src/connection.js'

const KEY = '11111111-2222-3333-4444-555555555555'

/** A stub upstream client recording credential writes. */
function stubClient({ theosFails = false } = {}) {
  const state = { key: '', theosCalls: 0 }
  return {
    state,
    lane: '7',
    baseUrl: 'https://api.deepai.org',
    get hasKey() { return state.key !== '' },
    setApiKey(value) { state.key = value },
    async theos() {
      state.theosCalls += 1
      if (theosFails) throw new Error('HTTP 401 auth_required')
      return { balance: 72.99, granted: 73, refreshAt: '2026-11-20T00:16:27+00:00' }
    },
  }
}

/** A stub catalog. */
function stubCatalog() {
  return {
    live: true,
    fetchedAt: Date.now(),
    list: () => new Map([['a', {}], ['b', {}]]),
    refresh: async () => true,
  }
}

/** A stub router. */
function stubRouter() {
  return {
    snapshot: () => ({
      remainingTheos: 72.99,
      budget: 73,
      frontierReady: ['x', 'y'],
      unmeteredReady: ['z'],
      exhausted: [],
      recentHandoffs: [{ at: 1, from: 'gpt-6-astra', to: 'glm-5.3', reason: 'transient' }],
      recentAttempts: [],
    }),
  }
}

/** A stub credential store. */
function stubStore() {
  const state = { saved: undefined, cleared: 0 }
  return {
    state,
    async save(account) { state.saved = account },
    async clear() { state.cleared += 1; state.saved = undefined },
  }
}

/** Build a controller over the stubs. */
function build({ config = {}, theosFails = false } = {}) {
  const client = stubClient({ theosFails })
  const catalog = stubCatalog()
  const router = stubRouter()
  const store = stubStore()
  const controller = new ConnectionController({
    client,
    catalog,
    router,
    store,
    config: {
      apiKey: '',
      baseUrl: 'https://api.deepai.org',
      modelBase: '/deepai_code',
      userAgent: 'node',
      ...config,
    },
    logger: { info() {}, warn() {}, debug() {} },
  })
  return { controller, client, catalog, store }
}

test('an account key must be a UUID', () => {
  assert.equal(looksLikeApiKey(KEY), true)
  assert.equal(looksLikeApiKey(KEY.toUpperCase()), true)
  assert.equal(looksLikeApiKey('not-a-key'), false)
  assert.equal(looksLikeApiKey(''), false)
  assert.equal(looksLikeApiKey(undefined), false)
})

test('the initial status reports the provider, catalog and router without any credential', () => {
  const { controller } = build()
  const status = controller.status()
  assert.equal(status.signedIn, false)
  assert.equal(status.credentialSource, 'none')
  assert.equal(status.provider.id, 'deepaicode')
  assert.equal(status.provider.lane, '7')
  assert.equal(status.catalog.count, 2)
  assert.equal(status.catalog.live, true)
  assert.equal(status.allowance, null)
  assert.equal(status.router.frontierReady, 2)
  assert.equal(status.router.unmeteredReady, 1)
  assert.deepEqual(status.signIn, { state: SIGN_IN_IDLE })
  assert.equal(status.error, null)
})

test('the credential source is what the settings page shows', () => {
  const { controller } = build()
  controller.setCredentialSource('desktop')
  assert.equal(controller.status().credentialSource, 'desktop')
  assert.equal(controller.credentialSource, 'desktop')
})

test('a pasted key is proven upstream before it is stored', async () => {
  const { controller, client, store } = build()
  const status = await controller.connectWithKey(KEY)
  assert.equal(client.state.key, KEY)
  assert.equal(client.state.theosCalls, 1)
  assert.equal(store.state.saved.apiKey, KEY)
  assert.equal(status.signedIn, true)
  assert.equal(status.credentialSource, 'store')
  assert.equal(status.allowance.balance, 72.99)
  assert.equal(status.allowance.granted, 73)
})

test('a key the provider refuses is never stored', async () => {
  const { controller, client, store } = build({ theosFails: true })
  await assert.rejects(() => controller.connectWithKey(KEY), /DeepAI rejected this key/)
  assert.equal(client.state.key, '')
  assert.equal(store.state.saved, undefined)
})

test('a malformed key is refused without any network call', async () => {
  const { controller, client } = build()
  await assert.rejects(() => controller.connectWithKey('oops'), /An API key is a 36-character UUID/)
  assert.equal(client.state.theosCalls, 0)
})

test('signing out clears the stored key when nothing higher supplies one', async () => {
  const { controller, client, store } = build()
  await controller.connectWithKey(KEY)
  const status = await controller.signOut()
  assert.equal(store.state.cleared, 1)
  assert.equal(client.state.key, '')
  assert.equal(status.signedIn, false)
  assert.equal(status.credentialSource, 'none')
  assert.equal(status.allowance, null)
})

test('signing out keeps a key that the plugin configuration supplies', async () => {
  const { controller, client } = build({ config: { apiKey: KEY } })
  const status = await controller.signOut()
  assert.equal(client.state.key, KEY, 'a higher layer still owns this credential')
  assert.equal(status.credentialSource, 'config')
})

test('refreshing re-reads the catalog and the allowance', async () => {
  const { controller, client, catalog } = build()
  let refreshes = 0
  catalog.refresh = async () => { refreshes += 1; return true }
  client.setApiKey(KEY)
  const status = await controller.refresh()
  assert.equal(refreshes, 1)
  assert.equal(status.allowance.balance, 72.99)
})

test('a refused allowance probe becomes a reported error, not a crash', async () => {
  const { controller, client } = build({ theosFails: true })
  client.setApiKey(KEY)
  const status = await controller.refresh()
  assert.match(status.error, /auth_required/)
})

test('a status snapshot stays free of network calls', async () => {
  const { controller, client } = build()
  client.setApiKey(KEY)
  controller.setAllowance({ balance: 5, granted: 73 })
  const before = client.state.theosCalls
  for (let index = 0; index < 5; index += 1) controller.status()
  assert.equal(client.state.theosCalls, before, 'polling the page must not spend upstream requests')
})

test('cancelling a sign-in that was never started is harmless', () => {
  const { controller } = build()
  assert.deepEqual(controller.cancelSignIn(), { state: SIGN_IN_IDLE })
})

test('the sign-in states are the documented constants', () => {
  assert.equal(SIGN_IN_IDLE, 'idle')
  assert.equal(SIGN_IN_PENDING, 'pending')
  assert.equal(SIGN_IN_CONNECTED, 'connected')
})
