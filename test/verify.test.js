import test from 'node:test'
import assert from 'node:assert/strict'

import { FreeModelVerifier, VERIFY_INTERVAL_MS, MIN_VERIFY_INTERVAL_MS, freeModelIds } from '../src/verify.js'

/** A catalog whose refresh outcome the test controls. */
function stubCatalog(models, { live = true } = {}) {
  const state = { models, live, refreshes: 0, failures: 0 }
  return {
    state,
    get live() { return state.live },
    get failures() { return state.failures },
    fetchedAt: live ? Date.now() : 0,
    list: () => new Map(state.models.map(model => [model.id, model])),
    async refresh() {
      state.refreshes += 1
      return true
    },
  }
}

/** A ladder builder the test controls per run. */
function stubRebuild(ladder) {
  const state = { calls: 0, ladder }
  return {
    state,
    rebuild: () => {
      state.calls += 1
      return state.ladder
    },
  }
}

/** Build a verifier over stubs, with every side effect captured. */
function build({ models = [], live = true, ladder, stored = null, now = 1_700_000_000_000 } = {}) {
  const catalog = stubCatalog(models, { live })
  const rebuilder = stubRebuild(ladder ?? { frontier: [], unmetered: [], reclassified: [], skipped: [] })
  const written = []
  const timers = []
  const cleared = []
  const logs = []
  const verifier = new FreeModelVerifier({
    catalog,
    config: { verifyFreeModelsEveryMs: 86_400_000 },
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      debug: () => {},
    },
    rebuild: rebuilder.rebuild,
    now: () => now,
    schedule: (callback, ms) => {
      const timer = { callback, ms, unref() {} }
      timers.push(timer)
      return timer
    },
    cancel: timer => cleared.push(timer),
    readReport: async () => stored,
    writeReport: async report => { written.push(report) },
  })
  return { verifier, catalog, rebuilder, written, timers, cleared, logs }
}

/** A ladder with the given free ids. */
function ladderOf(freeIds, extra = {}) {
  return {
    frontier: extra.frontier ?? [],
    unmetered: freeIds.map(id => ({ id, tier: 'unmetered', theos: 0 })),
    reclassified: extra.reclassified ?? [],
    skipped: extra.skipped ?? [],
  }
}

test('free ids are every zero-cost rung, unmetered first', () => {
  assert.deepEqual(freeModelIds(ladderOf(['a', 'b'])), ['a', 'b'])
  assert.deepEqual(
    freeModelIds({ unmetered: [{ id: 'free', theos: 0 }], frontier: [{ id: 'free-model-frontier', theos: 0 }, { id: 'paid', theos: 5 }] }),
    ['free', 'free-model-frontier'],
  )
})

test('the first check establishes a baseline instead of reporting everything as new', async () => {
  const { verifier, written } = build({ models: [{ id: 'a', label: 'A', cost: 0 }], ladder: ladderOf(['a', 'b']) })
  const report = await verifier.verify({ force: true })
  assert.deepEqual(report.freeIds, ['a', 'b'])
  assert.deepEqual(report.added, [], 'a first run has nothing to diff against')
  assert.deepEqual(report.removed, [])
  assert.equal(report.verified, true)
  assert.equal(written.length, 1, 'the report is persisted')
})

test('a later check reports what newly became free and what stopped being free', async () => {
  const stored = {
    checkedAt: 1_600_000_000_000,
    verified: true,
    catalogLive: true,
    catalogCount: 3,
    freeIds: ['a', 'b'],
    added: [],
    removed: [],
    reclassified: [],
    skipped: [],
  }
  const { verifier, logs } = build({
    models: [{ id: 'a', label: 'A', cost: 0 }, { id: 'c', label: 'C', cost: 0 }],
    ladder: ladderOf(['a', 'c'], {
      reclassified: [{ id: 'b', from: 'unmetered', to: 'frontier', theos: 3, label: 'B' }],
    }),
    stored,
  })
  await verifier.start()
  const report = await verifier.verify({ force: true })
  assert.deepEqual(report.added, ['c'])
  assert.deepEqual(report.removed, ['b'])
  assert.equal(report.reclassified.length, 1)
  assert.equal(report.reclassified[0].theos, 3)
  assert.ok(logs.some(([level, message]) => level === 'warn' && /now paid/.test(String(message))))
  verifier.stop()
})

test('the persisted report hydrates the baseline after a restart', async () => {
  const stored = {
    checkedAt: 1_600_000_000_000,
    verified: true,
    catalogLive: true,
    catalogCount: 2,
    freeIds: ['a', 'b'],
    added: [], removed: [], reclassified: [], skipped: [],
  }
  const { verifier } = build({ models: [], ladder: ladderOf(['a', 'b']), stored })
  await verifier.start()
  assert.deepEqual(verifier.report().freeIds, ['a', 'b'])
  assert.equal(verifier.report().ageMs, 1_700_000_000_000 - 1_600_000_000_000)
  verifier.stop()
})

test('a failed catalog read keeps the tiers and marks the check unverified', async () => {
  const { verifier, catalog } = build({ models: [], live: false, ladder: ladderOf(['a']) })
  catalog.state.failures = 1
  const report = await verifier.verify({ force: true })
  assert.equal(report.verified, false)
  assert.equal(report.catalogLive, false)
  assert.deepEqual(report.freeIds, ['a'], 'the ladder is still reported')
})

test('verification always rebuilds the routing tiers', async () => {
  const { verifier, rebuilder, catalog } = build({ models: [], ladder: ladderOf(['a']) })
  await verifier.verify({ force: true })
  assert.equal(rebuilder.state.calls, 1)
  assert.equal(catalog.state.refreshes, 1)
})

test('concurrent verifications share one run', async () => {
  const { verifier, rebuilder } = build({ models: [], ladder: ladderOf(['a']) })
  const [first, second] = await Promise.all([verifier.verify({ force: true }), verifier.verify({ force: true })])
  assert.equal(rebuilder.state.calls, 1)
  assert.deepEqual(first.freeIds, second.freeIds)
})

test('start arms one daily timer and stop clears it', async () => {
  const { verifier, timers, cleared } = build({ models: [], ladder: ladderOf(['a']) })
  await verifier.start()
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, VERIFY_INTERVAL_MS)
  assert.equal(verifier.report().scheduled, true)
  assert.ok(verifier.report().nextCheckAt > 0)
  verifier.stop()
  assert.equal(cleared.length, 1)
  assert.equal(verifier.report().scheduled, false)
})

test('the scheduled run verifies again and re-arms itself', async () => {
  const { verifier, timers, rebuilder } = build({ models: [], ladder: ladderOf(['a']) })
  await verifier.start()
  assert.equal(rebuilder.state.calls, 0, 'start only loads the baseline and arms the timer')
  timers[0].callback()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(rebuilder.state.calls, 1, 'the timer runs a verification')
  assert.equal(timers.length, 2, 'the next day is already scheduled')
  verifier.stop()
})

test('the cadence is clamped so a bad config cannot spin', () => {
  const { verifier } = (() => {
    const catalog = stubCatalog([], { live: true })
    const verifier = new FreeModelVerifier({
      catalog,
      config: { verifyFreeModelsEveryMs: 5 },
      logger: { info() {}, warn() {}, debug() {} },
      rebuild: () => ladderOf([]),
      schedule: () => ({ unref() {} }),
      cancel: () => {},
      readReport: async () => null,
      writeReport: async () => {},
    })
    return { verifier }
  })()
  assert.equal(verifier.intervalMs, MIN_VERIFY_INTERVAL_MS)
})
