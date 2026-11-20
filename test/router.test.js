import test from 'node:test'
import assert from 'node:assert/strict'

import { AutoRouter, classifyFailure, nextDailyReset, TRANSIENT_COOLDOWN_MS } from '../src/router.js'

/** Build a tiny ladder whose costs are easy to reason about. */
function ladder() {
  return {
    frontier: [
      { id: 'big', tier: 'frontier', label: 'Big', theos: 50, api: 'openai-completions', contextWindow: 128000, maxTokens: 8192 },
      { id: 'mid', tier: 'frontier', label: 'Mid', theos: 10, api: 'openai-completions', contextWindow: 128000, maxTokens: 8192 },
      { id: 'small', tier: 'frontier', label: 'Small', theos: 2, api: 'openai-completions', contextWindow: 128000, maxTokens: 8192 },
    ],
    unmetered: [
      { id: 'free-a', tier: 'unmetered', label: 'Free A', theos: 0, api: 'openai-completions', contextWindow: 128000, maxTokens: 8192 },
      { id: 'free-b', tier: 'unmetered', label: 'Free B', theos: 0, api: 'openai-completions', contextWindow: 128000, maxTokens: 8192 },
    ],
  }
}

function routerAt(now, options = {}) {
  const router = new AutoRouter({ now: () => now.value, budget: 250, maxFailovers: 8, ...options })
  router.setLadder(ladder())
  return router
}

test('unknown allowance still prefers the most capable Frontier model', () => {
  const now = { value: 1_000 }
  const router = routerAt(now)
  assert.deepEqual(router.plan().map(c => c.id), ['big', 'mid', 'small', 'free-a', 'free-b'])
})

test('a Frontier rung costs more than the remaining allowance is skipped', () => {
  const now = { value: 1_000 }
  const router = routerAt(now)
  router.setQuota(12)
  assert.deepEqual(router.plan().map(c => c.id), ['mid', 'small', 'free-a', 'free-b'])
})

test('strict priority: every affordable Frontier model precedes every Unmetered model', () => {
  const now = { value: 1_000 }
  const router = routerAt(now)
  router.setQuota(250)
  const order = router.plan().map(c => c.tier)
  const firstFree = order.indexOf('unmetered')
  assert.equal(firstFree, 3, 'all three Frontier rungs are ahead of the free tier')
  assert.ok(order.slice(firstFree).every(tier => tier === 'unmetered'))
})

test('an exhausted day falls through to Unmetered and remembers it', () => {
  const now = { value: 1_000 }
  const router = routerAt(now)
  router.setQuota(250)
  const [big] = router.plan()
  assert.equal(router.recordFailure(big, { status: 403, message: 'daily allowance exhausted' }), 'quota')
  assert.equal(router.remaining, 0, 'a quota refusal zeroes the estimate')
  assert.deepEqual(router.plan().map(c => c.id), ['free-a', 'free-b'])
})

test('the first Frontier refusal hands the request to the next Frontier model', () => {
  const now = { value: 1_000 }
  const router = routerAt(now)
  router.setQuota(250)
  const plan = router.plan()
  assert.equal(plan[0].id, 'big')
  assert.equal(router.recordFailure(plan[0], { status: 500 }), 'transient')
  const after = router.plan()
  assert.equal(after[0].id, 'mid')
  assert.ok(!after.some(c => c.id === 'big'), 'the failed model is cooling down')
})

test('a transient cooldown expires without a restart', () => {
  const now = { value: 1_000 }
  const router = routerAt(now)
  const [big] = router.plan()
  router.recordFailure(big, { status: 503 })
  assert.equal(router.plan()[0].id, 'mid')
  now.value += TRANSIENT_COOLDOWN_MS + 1
  assert.equal(router.plan()[0].id, 'big', 'the model returns once its cooldown elapses')
})

test('an authentication failure stops the chain without blaming any model', () => {
  const now = { value: 1_000 }
  const router = routerAt(now)
  const [big] = router.plan()
  assert.equal(router.recordFailure(big, { status: 401 }), 'auth')
  // An auth failure is a credential problem, so no model is cooled down and the
  // caller must abort rather than replay the request against another model.
  assert.deepEqual(router.plan().map(c => c.id), ['big', 'mid', 'small', 'free-a', 'free-b'])
})

test('a successful Frontier call does not guess at the allowance', () => {
  const now = { value: 1_000 }
  const router = routerAt(now)
  router.setQuota(250)
  const [big] = router.plan()
  router.recordSuccess(big)
  // Upstream bills per token, not per request, so the only authority on the
  // remaining allowance is the balance /theos reports.
  assert.equal(router.remaining, 250)
  router.setQuota(249.99728)
  assert.equal(router.remaining, 249.99728)
})

test('an unmetered success never touches the allowance', () => {
  const now = { value: 1_000 }
  const router = routerAt(now)
  router.setQuota(3)
  const plan = router.plan()
  assert.equal(plan[0].id, 'small', 'big and mid cost more than 3 Theos')
  const free = plan.find(c => c.tier === 'unmetered')
  router.recordSuccess(free)
  assert.equal(router.remaining, 3, 'an unmetered call spends nothing')
  router.recordSuccess(plan[0])
  assert.equal(router.remaining, 3, 'a Frontier call is priced by the provider, not by us')
})

test('maxFailovers caps the paid tier but never drops the free tier', () => {
  const now = { value: 1_000 }
  const router = routerAt(now, { maxFailovers: 2 })
  const plan = router.plan()
  assert.deepEqual(plan.map(c => c.id), ['big', 'mid', 'free-a', 'free-b'])
  assert.deepEqual(plan.filter(c => c.tier === 'frontier').map(c => c.id), ['big', 'mid'])
  assert.equal(plan.filter(c => c.tier === 'unmetered').length, 2, 'the free tier is always reachable')
})

test('a quota refusal on a Frontier model retires the whole paid tier', () => {
  const now = { value: 1_000 }
  const router = routerAt(now)
  router.setQuota(250)
  const [big] = router.plan()
  assert.equal(router.recordFailure(big, { status: 403, code: 'theos_insufficient', message: 'You do not have enough Theos left for this request.' }), 'quota')
  // Every Frontier model draws on the same balance, so retrying them would only
  // repeat the same 403; the next plan starts at the free tier.
  assert.deepEqual(router.plan().map(c => c.id), ['free-a', 'free-b'])
  assert.equal(router.remaining, 0)
})

test('a quota refusal with an unknown balance still retires the paid tier', () => {
  const now = { value: 1_000 }
  const router = routerAt(now)
  assert.equal(router.remaining, null)
  const [big] = router.plan()
  router.recordFailure(big, { status: 403, message: 'not enough Theos' })
  assert.deepEqual(router.plan().map(c => c.id), ['free-a', 'free-b'])
})

test('recordHandoff keeps the fallback history the plugin reports', () => {
  const now = { value: 1_000 }
  const router = routerAt(now)
  router.recordHandoff('big', 'mid', 'transient')
  const snapshot = router.snapshot()
  assert.deepEqual(snapshot.recentHandoffs, [{ at: 1_000, from: 'big', to: 'mid', reason: 'transient' }])
})

test('failure classification maps statuses onto reactions', () => {
  assert.equal(classifyFailure({ status: 426 }), 'lane')
  assert.equal(classifyFailure({ status: 409 }), 'busy')
  assert.equal(classifyFailure({ status: 401 }), 'auth')
  assert.equal(classifyFailure({ status: 403, message: 'check_in_refused' }), 'quota')
  assert.equal(classifyFailure({ status: 403, message: 'network_bound' }), 'quota')
  assert.equal(classifyFailure({ status: 429 }), 'quota')
  assert.equal(classifyFailure({ status: 400 }), 'rejected')
  assert.equal(classifyFailure({ code: 'QUOTA_EXCEEDED' }), 'quota')
  assert.equal(classifyFailure({ status: 502 }), 'transient')
  assert.equal(classifyFailure({ code: 'TIMEOUT' }), 'transient')
})

test('the daily reset is the next UTC midnight', () => {
  const now = Date.UTC(2026, 10, 19, 23, 0, 0)
  assert.equal(nextDailyReset(now), Date.UTC(2026, 10, 20, 0, 0, 0))
})

test('an exhausted set clears after the daily reset', () => {
  const start = Date.UTC(2026, 10, 19, 10, 0, 0)
  const now = { value: start }
  const router = routerAt(now)
  router.setQuota(250)
  const [big] = router.plan()
  router.recordFailure(big, { status: 403, message: 'quota exhausted' })
  assert.ok(!router.plan().some(c => c.id === 'big'))
  now.value = Date.UTC(2026, 10, 20, 0, 0, 1)
  router.setQuota(250)
  assert.ok(router.plan().some(c => c.id === 'big'), 'the new day restores the Frontier model')
})
