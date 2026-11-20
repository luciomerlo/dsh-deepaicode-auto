import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildLadder,
  catalogApi,
  catalogCost,
  DEFAULT_FRONTIER,
  DEFAULT_UNMETERED,
  modelBadge,
  normalizeCatalogEntry,
} from '../src/models.js'

test('the fallback Frontier table keeps the configured capability order', () => {
  const ladder = buildLadder({})
  assert.deepEqual(ladder.frontier.map(m => m.id), DEFAULT_FRONTIER.map(m => m.id))
  assert.equal(ladder.frontier[0].id, 'gpt-6-astra')
  assert.equal(ladder.frontier[0].theos, 50)
  assert.deepEqual(ladder.unmetered.map(m => m.id), [...DEFAULT_UNMETERED])
})

test('an unmetered model never lands on the Frontier rung', () => {
  const ladder = buildLadder({})
  const unmeteredIds = new Set(ladder.unmetered.map(m => m.id))
  assert.ok(ladder.frontier.every(m => !unmeteredIds.has(m.id)))
  assert.ok(ladder.unmetered.every(m => m.theos === 0))
})

test('the catalog cost overrides the configured cost', () => {
  const catalog = new Map([
    ['gpt-6-astra', { id: 'gpt-6-astra', label: 'GPT-6 Astra', cost: 42, api: 'openai-responses', contextWindow: 400000, maxTokens: 16384 }],
  ])
  const ladder = buildLadder({}, catalog)
  const astra = ladder.frontier.find(m => m.id === 'gpt-6-astra')
  assert.equal(astra.theos, 42)
  assert.equal(astra.api, 'openai-responses')
  assert.equal(astra.contextWindow, 400000)
})

test('a catalog model the config omits is appended, most expensive first', () => {
  const catalog = new Map([
    ['brand-new-9', { id: 'brand-new-9', label: 'Brand New 9', cost: 80, api: 'openai-completions', contextWindow: 1, maxTokens: 1 }],
    ['cheap-new', { id: 'cheap-new', label: 'Cheap New', cost: 4, api: 'openai-completions', contextWindow: 1, maxTokens: 1 }],
    ['zero-new', { id: 'zero-new', label: 'Zero New', cost: 0, api: 'openai-completions', contextWindow: 1, maxTokens: 1 }],
  ])
  const ladder = buildLadder({}, catalog)
  const tail = ladder.frontier.slice(DEFAULT_FRONTIER.length).map(m => m.id)
  assert.deepEqual(tail, ['brand-new-9', 'cheap-new'])
  assert.ok(ladder.unmetered.some(m => m.id === 'zero-new'), 'a zero-cost catalog model joins the free tier')
  assert.equal(ladder.unmetered.at(-1).id, 'zero-new')
})

test('a model listed in both tiers is treated as Frontier once', () => {
  const ladder = buildLadder({
    frontier: [{ id: 'both', theos: 3 }],
    unmetered: ['both', 'free-only'],
  })
  assert.equal(ladder.frontier.filter(m => m.id === 'both').length, 1)
  assert.equal(ladder.unmetered.filter(m => m.id === 'both').length, 0)
})

test('an empty configured list falls back to the built-in tables', () => {
  const ladder = buildLadder({ frontier: [], unmetered: [] })
  assert.equal(ladder.frontier.length, DEFAULT_FRONTIER.length)
  assert.equal(ladder.unmetered.length, DEFAULT_UNMETERED.length)
})

test('catalog cost accepts every documented spelling', () => {
  assert.equal(catalogCost({ theos: 12 }), 12)
  assert.equal(catalogCost({ cost: '7' }), 7)
  assert.equal(catalogCost({ price: { theos: 3 } }), 3)
  assert.equal(catalogCost({ unmetered: true, cost: 99 }), 0)
  assert.equal(catalogCost({ free: true }), 0)
  assert.equal(catalogCost({}), undefined)
  assert.equal(catalogCost({ theos: -1 }), undefined)
})

test('the catalog API family selects the responses endpoint', () => {
  assert.equal(catalogApi({ api: 'openai-responses' }), 'openai-responses')
  assert.equal(catalogApi({ api: 'responses' }), 'openai-completions')
  assert.equal(catalogApi({}), 'openai-completions')
})

test('a raw catalog entry normalizes to adapter metadata with safe defaults', () => {
  const normalized = normalizeCatalogEntry({ id: 'x', context_window: '200000' })
  assert.equal(normalized.id, 'x')
  assert.equal(normalized.label, 'x')
  assert.equal(normalized.contextWindow, 200000)
  assert.equal(normalized.maxTokens, 8192)
  assert.equal(normalizeCatalogEntry({ name: 'only-name' }).id, 'only-name')
  assert.equal(normalizeCatalogEntry({ label: 'no id' }), undefined)
})

test('the selector badge distinguishes a priced model from an unmetered one', () => {
  assert.equal(modelBadge({ tier: 'frontier', theos: 15 }), '15 Theos')
  assert.equal(modelBadge({ tier: 'unmetered', theos: 0 }), 'Unmetered · 0 Theos')
})

test('a configured free model that the live catalog prices becomes Frontier', () => {
  const catalog = new Map([
    ['deepseek-v4.1-flash', { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', cost: 4, api: 'openai-completions', contextWindow: 1, maxTokens: 1 }],
  ])
  const ladder = buildLadder({ unmetered: ['deepseek-v4.1-flash', 'free-two'] }, catalog, { authoritative: true })
  assert.equal(ladder.unmetered.some(rung => rung.id === 'deepseek-v4.1-flash'), false, 'it must not stay free')
  const moved = ladder.frontier.find(rung => rung.id === 'deepseek-v4.1-flash')
  assert.ok(moved, 'it is still reachable, as a priced model')
  assert.equal(moved.theos, 4)
  assert.equal(moved.reclassified, true)
  assert.deepEqual(ladder.reclassified, [{ id: 'deepseek-v4.1-flash', from: 'unmetered', to: 'frontier', theos: 4, label: 'DeepSeek V4.1 Flash' }])
})

test('a configured model the live catalog no longer lists leaves the ladder', () => {
  const catalog = new Map([
    ['kept', { id: 'kept', label: 'Kept', cost: 0, api: 'openai-completions', contextWindow: 1, maxTokens: 1 }],
  ])
  const ladder = buildLadder({
    frontier: [{ id: 'gone-frontier', theos: 5 }],
    unmetered: ['kept', 'gone-free'],
  }, catalog, { authoritative: true })
  assert.deepEqual(ladder.unmetered.map(rung => rung.id), ['kept'])
  assert.equal(ladder.frontier.some(rung => rung.id === 'gone-frontier'), false)
  assert.deepEqual(ladder.skipped.sort(), ['gone-free', 'gone-frontier'])
})

test('without a live catalog the configured tiers stand unchanged', () => {
  const ladder = buildLadder({ unmetered: ['free-one'] })
  assert.equal(ladder.authoritative, false)
  assert.ok(ladder.unmetered.some(rung => rung.id === 'free-one'))
  assert.deepEqual(ladder.reclassified, [])
  assert.deepEqual(ladder.skipped, [])
})

test('a zero-cost catalog entry stays free even when configured as Frontier', () => {
  const catalog = new Map([
    ['was-paid', { id: 'was-paid', label: 'Was Paid', cost: 0, api: 'openai-completions', contextWindow: 1, maxTokens: 1 }],
  ])
  const ladder = buildLadder({ frontier: [{ id: 'was-paid', theos: 15 }] }, catalog, { authoritative: true })
  const rung = ladder.frontier.find(r => r.id === 'was-paid')
  assert.equal(rung.theos, 0)
  assert.equal(modelBadge(rung), 'Unmetered · 0 Theos', 'the picker must not advertise a cost it does not charge')
})
