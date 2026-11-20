import test from 'node:test'
import assert from 'node:assert/strict'

import { createFreeModelsTool, FREE_MODELS_TOOL, summarizeVerification } from '../src/tools.js'

/** A report as the verifier publishes it. */
function report(overrides = {}) {
  return {
    checkedAt: 1_700_000_000_000,
    verified: true,
    catalogLive: true,
    catalogCount: 27,
    freeIds: ['deepseek-v4.1-flash', 'glm-5.3-flash'],
    added: ['glm-5.3-flash'],
    removed: [],
    reclassified: [{ id: 'gpt-6-luna', from: 'unmetered', to: 'frontier', theos: 4, label: 'GPT-6 Luna' }],
    skipped: [],
    intervalMs: 86_400_000,
    nextCheckAt: 1_700_086_400_000,
    ageMs: 1000,
    scheduled: true,
    ...overrides,
  }
}

test('the summary carries the free tier and what changed', () => {
  const summary = summarizeVerification(report())
  assert.equal(summary.freeCount, 2)
  assert.deepEqual(summary.freeModels, ['deepseek-v4.1-flash', 'glm-5.3-flash'])
  assert.deepEqual(summary.newlyFree, ['glm-5.3-flash'])
  assert.deepEqual(summary.noLongerFree, [{ id: 'gpt-6-luna', theos: 4 }])
  assert.equal(summary.source, 'live catalog')
  assert.equal(summary.checkedEveryHours, 24)
  assert.match(summary.checkedAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('an unknown instant is omitted, never null', () => {
  // The declared output schema types these fields as strings and the tool layer
  // validates the returned object against it, so a null would reject the call.
  const summary = summarizeVerification(report({ checkedAt: 0, nextCheckAt: null }))
  assert.equal('checkedAt' in summary, false)
  assert.equal('nextCheckAt' in summary, false)
  for (const [key, value] of Object.entries(summary)) {
    assert.notEqual(value, null, `${key} must not be null`)
  }
})

test('an unverified report says so', () => {
  const summary = summarizeVerification(report({ verified: false, catalogLive: false }))
  assert.equal(summary.verified, false)
  assert.equal(summary.source, 'published table')
})

test('the tool reports the last check without touching the network', async () => {
  const calls = []
  const tool = createFreeModelsTool({
    verifier: {
      report: () => { calls.push('report'); return report() },
      verify: async () => { calls.push('verify'); return report() },
    },
  })
  assert.equal(tool.name, FREE_MODELS_TOOL)
  const value = await tool.execute({})
  assert.deepEqual(calls, ['report'])
  assert.equal(value.freeCount, 2)
})

test('verify: true re-reads the catalog through the verifier', async () => {
  const calls = []
  const tool = createFreeModelsTool({
    verifier: {
      report: () => { calls.push('report'); return report() },
      verify: async options => { calls.push(`verify:${String(options.force)}`); return report() },
    },
  })
  await tool.execute({ verify: true })
  assert.deepEqual(calls, ['verify:true'])
})

test('the tool definition is shaped for the tools service', () => {
  const tool = createFreeModelsTool({ verifier: { report: () => report(), verify: async () => report() } })
  assert.equal(tool.name, 'deepaicode_free_models')
  assert.equal(typeof tool.description, 'string')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.equal(tool.parameters.properties.verify.type, 'boolean')
  assert.equal(tool.output.schema.type, 'object')
  assert.equal(typeof tool.output.render, 'function')
  const blocks = tool.output.render({}, { freeCount: 2 })
  assert.equal(blocks[0].type, 'text')
  assert.match(blocks[0].text, /freeCount/)
})
