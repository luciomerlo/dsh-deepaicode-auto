import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject, name, resolveConfig } from '../index.js'

/**
 * A minimal Cordis-like context recording what the plugin registers.
 * The effect callback is captured, not run, so activation stays off the network.
 */
function stubContext() {
  const registrations = []
  const effects = []
  const logs = []
  return {
    registrations,
    effects,
    logs,
    llm: {
      registerAdapter(providers, adapter) {
        registrations.push({ providers, adapter })
        return Object.assign(() => {}, { replace() {} })
      },
    },
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      debug: (...args) => logs.push(['debug', ...args]),
    },
    effect(callback, label) {
      effects.push({ callback, label })
      return () => {}
    },
  }
}

test('the plugin declares its identity and its single dependency', () => {
  assert.equal(name, 'deepaicode-auto')
  assert.deepEqual(inject, ['llm'])
})

test('apply registers exactly one provider route on ctx.llm', () => {
  const ctx = stubContext()
  apply(ctx, {})
  assert.equal(ctx.registrations.length, 1)
  const [registration] = ctx.registrations
  assert.deepEqual(registration.providers, ['deepaicode'])
  assert.deepEqual(registration.adapter.providerInfo('deepaicode'), { id: 'deepaicode', name: 'DeepAI Code' })
})

test('the registered adapter advertises Auto (DeepAiCode) and the published ladder', async () => {
  const ctx = stubContext()
  apply(ctx, {})
  const adapter = ctx.registrations[0].adapter
  const models = await adapter.listModels('deepaicode')
  assert.equal(models[0].id, 'auto')
  assert.equal(models[0].name, 'Auto (DeepAiCode)')
  const ids = models.map(model => model.id)
  assert.ok(ids.includes('gpt-6-astra'), 'the most capable Frontier model is selectable on its own')
  assert.ok(ids.includes('deepseek-v4.1-flash'), 'the unmetered tier is selectable on its own')
  assert.equal(ids.length, 28, '27 published models plus the virtual Auto model')
  assert.equal(new Set(ids).size, ids.length)
})

test('the harness retry layer is told not to retry, because failover is the adapter\'s job', () => {
  const ctx = stubContext()
  apply(ctx, {})
  const policy = ctx.registrations[0].adapter.providerRetryPolicy('deepaicode')
  assert.equal(policy.mode, 'normal')
  assert.equal(policy.maxRetries, 0)
})

test('activation schedules startup work under one owned effect', () => {
  const ctx = stubContext()
  apply(ctx, {})
  assert.equal(ctx.effects.length, 1)
  const disposer = ctx.effects[0].callback()
  assert.equal(typeof disposer, 'function')
  disposer()
})

test('an invalid config is refused with a readable message', () => {
  assert.throws(() => resolveConfig({ baseUrl: '' }), /baseUrl must be a non-empty URL/)
  assert.throws(() => resolveConfig({ lane: 0 }), /lane must be a positive integer/)
  assert.throws(() => resolveConfig({ frontier: 'nope' }), /frontier must be a list/)
})

test('defaults match the published DeepAI Code allowance and lane', () => {
  const config = resolveConfig({})
  assert.equal(config.baseUrl, 'https://api.deepai.org')
  assert.equal(config.dailyTheosBudget, 250)
  assert.equal(config.lane, 7)
  assert.equal(config.autoModelName, 'Auto (DeepAiCode)')
})

test('a configured lane and budget reach the adapter', () => {
  const ctx = stubContext()
  apply(ctx, { lane: 9, dailyTheosBudget: 450, autoModelId: 'smart', autoModelName: 'Auto custom' })
  assert.equal(ctx.registrations[0].adapter.providerInfo('deepaicode').name, 'DeepAI Code')
  return ctx.registrations[0].adapter.listModels('deepaicode').then(models => {
    assert.equal(models[0].id, 'smart')
    assert.equal(models[0].name, 'Auto custom')
  })
})
