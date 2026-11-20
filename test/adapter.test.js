import test from 'node:test'
import assert from 'node:assert/strict'

import { createAdapter } from '../src/adapter.js'
import { AutoRouter } from '../src/router.js'
import { UpstreamError } from '../src/client.js'

/** Encode frames as an SSE byte stream, like the upstream endpoint does. */
function sseBody(frames) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
}

/** A body that sends its frames and then goes silent without ever closing. */
function stallingBody(frames) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
    },
  })
}

/** One healthy upstream chunk carrying text. */
function textFrame(text) {
  return { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }
}

/** The usage-and-finish tail a healthy upstream turn ends with. */
function stopFrames(text) {
  return [
    textFrame(text),
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 3 } },
  ]
}

/**
 * A stub upstream client whose behaviour is scripted per model.
 * @param {Record<string, {frames?: object[], error?: Error}>} scripts - per-model outcome.
 */
function stubClient(scripts) {
  const calls = []
  return {
    calls,
    lane: '7',
    hasKey: true,
    setApiKey() {},
    setMachine() {},
    async ensureCheckIn() {
      return { balance: 250, granted: 250 }
    },
    async openStream(_options, target) {
      calls.push(target.model)
      const script = scripts[target.model]
      if (script === undefined) throw new UpstreamError(400, 'invalid_request_error', `no script for ${target.model}`)
      if (script.error !== undefined) throw script.error
      if (script.stall === true) return { body: stallingBody(script.frames ?? []), status: 200 }
      return { body: sseBody(script.frames ?? []), status: 200 }
    },
  }
}

const CONFIG = {
  autoModelId: 'auto',
  autoModelName: 'Auto (DeepAiCode)',
  refreshCatalogOnError: true,
  frontier: [
    { id: 'frontier-a', theos: 20, label: 'Frontier A' },
    { id: 'frontier-b', theos: 10, label: 'Frontier B' },
  ],
  unmetered: ['free-a', 'free-b'],
}

const CATALOG = {
  live: true,
  fetchedAt: Date.now(),
  list: () => new Map(),
  refresh: async () => false,
}

const LOGGER = { info() {}, warn() {}, debug() {} }

/** Build an adapter over the given scripts and config. */
function buildAdapter(scripts, config = CONFIG) {
  const client = stubClient(scripts)
  const router = new AutoRouter({ budget: 250, maxFailovers: 8 })
  const adapter = createAdapter({ router, client, catalog: CATALOG, config, logger: LOGGER })
  return { adapter, client, router }
}

/** Drain an async iterable into an array. */
async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

test('Auto answers with the highest Frontier model when it works', async () => {
  const { adapter, client } = buildAdapter({
    'frontier-a': { frames: stopFrames('hello from astra') },
  })
  const chunks = await collect(adapter.stream({ provider: 'deepaicode', model: 'auto', messages: [] }))
  assert.deepEqual(client.calls, ['frontier-a'])
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  assert.equal(text, 'hello from astra')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('Auto switches to the next Frontier model when the first throws', async () => {
  const { adapter, client } = buildAdapter({
    'frontier-a': { error: new UpstreamError(502, 'server_error', 'upstream failed') },
    'frontier-b': { frames: stopFrames('hello from sol') },
  })
  const chunks = await collect(adapter.stream({ provider: 'deepaicode', model: 'auto', messages: [] }))
  assert.deepEqual(client.calls, ['frontier-a', 'frontier-b'])
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'hello from sol')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('Auto falls through to Unmetered when the allowance is gone', async () => {
  const { adapter, client } = buildAdapter({
    'frontier-a': { error: new UpstreamError(403, 'theos_exhausted', 'daily Theos allowance is used up') },
    'frontier-b': { error: new UpstreamError(403, 'theos_exhausted', 'daily Theos allowance is used up') },
    'free-a': { frames: stopFrames('hello from deepseek flash') },
  })
  const chunks = await collect(adapter.stream({ provider: 'deepaicode', model: 'auto', messages: [] }))
  assert.deepEqual(client.calls, ['frontier-a', 'frontier-b', 'free-a'])
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'hello from deepseek flash')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('an exhausted allowance retires the Frontier tier for the rest of the day', async () => {
  const { adapter, client, router } = buildAdapter({
    'frontier-a': { error: new UpstreamError(403, 'theos_exhausted', 'no Theos left') },
    'free-a': { frames: stopFrames('free answer') },
  })
  await collect(adapter.stream({ provider: 'deepaicode', model: 'auto', messages: [] }))
  assert.equal(router.remaining, 0)
  client.calls.length = 0
  await collect(adapter.stream({ provider: 'deepaicode', model: 'auto', messages: [] }))
  assert.deepEqual(client.calls, ['free-a'], 'the second turn goes straight to the unmetered tier')
})

test('an authentication failure stops the chain instead of trying other models', async () => {
  const { adapter, client } = buildAdapter({
    'frontier-a': { error: new UpstreamError(401, 'auth_required', 'sign in to DeepAI') },
    'frontier-b': { frames: stopFrames('should never run') },
  })
  const chunks = await collect(adapter.stream({ provider: 'deepaicode', model: 'auto', messages: [] }))
  assert.deepEqual(client.calls, ['frontier-a'], 'one model is attempted when the credential is refused')
  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'auth_required')
})

test('Auto reports an error when every model fails', async () => {
  const { adapter, client } = buildAdapter({
    'frontier-a': { error: new UpstreamError(500, 'server_error', 'boom') },
    'frontier-b': { error: new UpstreamError(500, 'server_error', 'boom') },
    'free-a': { error: new UpstreamError(500, 'server_error', 'boom') },
    'free-b': { error: new UpstreamError(500, 'server_error', 'boom') },
  })
  const chunks = await collect(adapter.stream({ provider: 'deepaicode', model: 'auto', messages: [] }))
  assert.deepEqual(client.calls, ['frontier-a', 'frontier-b', 'free-a', 'free-b'])
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.match(finish.reason.failure.message, /exhausted every model/)
})

test('a failure after output was streamed is not retried on another model', async () => {
  const { adapter, client } = buildAdapter({
    'frontier-a': {
      frames: [
        textFrame('partial answer'),
        { error: { message: 'upstream cut the connection', code: 'TRANSPORT' } },
      ],
    },
    'frontier-b': { frames: stopFrames('should never run') },
  })
  const chunks = await collect(adapter.stream({ provider: 'deepaicode', model: 'auto', messages: [] }))
  assert.deepEqual(client.calls, ['frontier-a'], 'visible output cannot be replayed against a different model')
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'partial answer')
  assert.equal(chunks.at(-1).reason.kind, 'error')
})

test('an empty upstream answer counts as a failure and fails over', async () => {
  const { adapter, client } = buildAdapter({
    'frontier-a': { frames: [{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }] },
    'frontier-b': { frames: stopFrames('recovered') },
  })
  const chunks = await collect(adapter.stream({ provider: 'deepaicode', model: 'auto', messages: [] }))
  assert.deepEqual(client.calls, ['frontier-a', 'frontier-b'])
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'recovered')
})

test('the SSE watchdog turns a silent stream into a failover', async () => {
  const { adapter, client } = buildAdapter({
    'frontier-a': { stall: true },
    'frontier-b': { frames: stopFrames('recovered after the stall') },
  }, { ...CONFIG, streamIdleTimeoutMs: 25 })
  const chunks = await collect(adapter.stream({ provider: 'deepaicode', model: 'auto', messages: [] }))
  assert.deepEqual(client.calls, ['frontier-a', 'frontier-b'])
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'recovered after the stall')
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('a stall after output was streamed is reported, not replayed', async () => {
  const { adapter, client } = buildAdapter({
    'frontier-a': { stall: true, frames: [textFrame('visible prefix')] },
    'frontier-b': { frames: stopFrames('should never run') },
  }, { ...CONFIG, streamIdleTimeoutMs: 25 })
  const chunks = await collect(adapter.stream({ provider: 'deepaicode', model: 'auto', messages: [] }))
  assert.deepEqual(client.calls, ['frontier-a'], 'the watchdog fires but nothing is replayed')
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'visible prefix')
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'TIMEOUT')
})

test('an explicit model streams without switching to another model', async () => {
  const { adapter, client } = buildAdapter({
    'frontier-b': { frames: stopFrames('chosen model answer') },
  })
  const chunks = await collect(adapter.stream({ provider: 'deepaicode', model: 'frontier-b', messages: [] }))
  assert.deepEqual(client.calls, ['frontier-b'])
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('an explicit model surfaces its own failure', async () => {
  const { adapter, client } = buildAdapter({
    'frontier-a': { error: new UpstreamError(429, 'rate_limited', 'slow down') },
  })
  const chunks = await collect(adapter.stream({ provider: 'deepaicode', model: 'frontier-a', messages: [] }))
  assert.deepEqual(client.calls, ['frontier-a'])
  assert.equal(chunks.at(-1).reason.kind, 'error')
})

test('failoverExplicitModels opts an explicit model into continuing on another', async () => {
  const { adapter, client } = buildAdapter({
    'frontier-a': { error: new UpstreamError(502, 'server_error', 'boom') },
    'frontier-b': { frames: stopFrames('continued') },
  }, { ...CONFIG, failoverExplicitModels: true })
  const chunks = await collect(adapter.stream({ provider: 'deepaicode', model: 'frontier-a', messages: [] }))
  assert.deepEqual(client.calls, ['frontier-a', 'frontier-b'])
  assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), 'continued')
})

test('the selector catalog advertises Auto first, then the priced and unmetered tiers', async () => {
  const { adapter } = buildAdapter({})
  const models = await adapter.listModels('deepaicode')
  assert.equal(models[0].id, 'auto')
  assert.equal(models[0].name, 'Auto (DeepAiCode)')
  assert.deepEqual(models.map(m => m.id), ['auto', 'frontier-a', 'frontier-b', 'free-a', 'free-b'])
  assert.equal(models.find(m => m.id === 'frontier-a').badge.text, '20 Theos')
  assert.equal(models.find(m => m.id === 'free-a').badge.text, 'Unmetered · 0 Theos')
  assert.equal(new Set(models.map(m => m.id)).size, models.length, 'model ids must be unique')
})

test('resolveModel advertises the widest context for Auto and the exact one for a real model', async () => {
  const { adapter } = buildAdapter({})
  const auto = await adapter.resolveModel('deepaicode', 'auto')
  assert.equal(auto.id, 'auto')
  assert.ok(auto.context.contextWindow >= 131072)
  const explicit = await adapter.resolveModel('deepaicode', 'frontier-b')
  assert.equal(explicit.id, 'frontier-b')
  assert.equal(explicit.defaultMaxTokens > 0, true)
})

/**
 * Every member of the harness `LlmAdapter` contract, from
 * `@deepseek-ai/dsh-llm`. Registering a route validates only the first two, but
 * the runtime calls all of them later — `imageRequestPricing` is reached by the
 * token meter during a model-switch compaction, where a missing member fails the
 * turn instead of the registration.
 */
const LLM_ADAPTER_CONTRACT = [
  'providerInfo',
  'providerRetryPolicy',
  'imageRequestPricing',
  'imageRequestTarget',
  'listModels',
  'resolveModel',
  'prepareCall',
  'stream',
]

test('the adapter implements the whole LlmAdapter contract, not just the validated part', () => {
  const { adapter } = buildAdapter({})
  for (const member of LLM_ADAPTER_CONTRACT) {
    assert.equal(typeof adapter[member], 'function', `the adapter must implement ${member}()`)
  }
})

test('the image-pricing defaults match the base adapter, because no image is ever sent', () => {
  const { adapter } = buildAdapter({})
  // A compaction that switches models calls this before any request; returning
  // undefined is what makes the token meter use its neutral estimate.
  assert.equal(adapter.imageRequestPricing('deepaicode', 'auto'), undefined)
  assert.equal(adapter.imageRequestPricing('deepaicode', 'frontier-a'), undefined)
  const target = adapter.imageRequestTarget('deepaicode', 'auto', { width: 640, height: 480, bytes: 1234 })
  assert.deepEqual(target, { width: 640, height: 480, maxBytes: 1234 })
})
