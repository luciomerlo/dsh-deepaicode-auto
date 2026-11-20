import test from 'node:test'
import assert from 'node:assert/strict'

import { buildResponsesBody, DEFAULT_SYSTEM_PROMPT } from '../src/body.js'
import { toResponsesChunks, responsesUsage } from '../src/stream.js'

/** Encode events as an SSE byte stream. */
function sseBody(events) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      controller.close()
    },
  })
}

/** Drain an async iterable. */
async function collect(iterable) {
  const out = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

// Event sequence captured from a live `/deepai_code/responses` request.
const TEXT_TURN = [
  { type: 'response.created', sequence_number: 0, response: { id: 'gen-1', status: 'in_progress', output: [], usage: { input_tokens: 0, output_tokens: 0 } } },
  { type: 'response.in_progress', sequence_number: 1, response: { id: 'gen-1', status: 'in_progress' } },
  { type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: { type: 'message', id: 'msg_1', status: 'in_progress', role: 'assistant', content: [{ type: 'output_text', text: '' }] } },
  { type: 'response.content_part.added', sequence_number: 3, item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
  { type: 'response.output_text.delta', sequence_number: 4, item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'RESP' },
  { type: 'response.output_text.delta', sequence_number: 5, item_id: 'msg_1', output_index: 0, content_index: 0, delta: '-OK' },
  { type: 'response.output_text.done', sequence_number: 6, item_id: 'msg_1', output_index: 0, content_index: 0, text: 'RESP-OK' },
  { type: 'response.content_part.done', sequence_number: 7, item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: 'RESP-OK' } },
  { type: 'response.output_item.done', sequence_number: 8, output_index: 0, item: { type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'RESP-OK' }] } },
  { type: 'response.completed', sequence_number: 9, response: { id: 'gen-1', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'RESP-OK' }] }], usage: { input_tokens: 49, output_tokens: 3, input_tokens_details: { cached_tokens: 12 }, output_tokens_details: { reasoning_tokens: 1 } } } },
]

const TOOL_TURN = [
  { type: 'response.created', sequence_number: 0, response: { id: 'gen-2', status: 'in_progress' } },
  { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'list_directory', arguments: '', status: 'in_progress' } },
  { type: 'response.function_call_arguments.delta', sequence_number: 2, item_id: 'fc_1', output_index: 0, delta: '{"path"' },
  { type: 'response.function_call_arguments.delta', sequence_number: 3, item_id: 'fc_1', output_index: 0, delta: ':"/srv/project"}' },
  { type: 'response.function_call_arguments.done', sequence_number: 4, item_id: 'fc_1', output_index: 0, arguments: '{"path":"/srv/project"}' },
  { type: 'response.output_item.done', sequence_number: 5, output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_abc', name: 'list_directory', arguments: '{"path":"/srv/project"}', status: 'completed' } },
  { type: 'response.completed', sequence_number: 6, response: { id: 'gen-2', status: 'completed', usage: { input_tokens: 88, output_tokens: 14 } } },
]

test('a text turn becomes text chunks and a stop finish', async () => {
  const chunks = await collect(toResponsesChunks(sseBody(TEXT_TURN), 'gpt-6-astra'))
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  assert.equal(text, 'RESP-OK')
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'text' })
  const end = chunks.find(c => c.type === 'block-end')
  assert.deepEqual(end.block, { type: 'text', text: 'RESP-OK' })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  const usage = chunks.find(c => c.type === 'usage')
  assert.deepEqual(usage.usage, { inputTokens: 49, outputTokens: 3, cacheReadTokens: 12, reasoningTokens: 1 })
  assert.ok(chunks.findIndex(c => c.type === 'usage') < chunks.length - 1, 'usage precedes finish')
})

test('a tool turn becomes a tool-call block and a tool-calls finish', async () => {
  const chunks = await collect(toResponsesChunks(sseBody(TOOL_TURN), 'gpt-6-astra'))
  assert.deepEqual(chunks[0], { type: 'block-start', index: 0, blockType: 'tool-call' })
  const deltas = chunks.filter(c => c.type === 'tool-call-delta')
  assert.equal(deltas.map(c => c.argumentsDelta).join(''), '{"path":"/srv/project"}')
  assert.equal(deltas[0].id, 'call_abc')
  assert.equal(deltas[0].name, 'list_directory')
  const end = chunks.find(c => c.type === 'block-end')
  assert.deepEqual(end.block, { type: 'tool-call', id: 'call_abc', name: 'list_directory', arguments: '{"path":"/srv/project"}' })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('a failed response becomes an error finish', async () => {
  const chunks = await collect(toResponsesChunks(sseBody([
    { type: 'response.created', response: { id: 'gen-3', status: 'in_progress' } },
    { type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'upstream exploded' } } },
  ]), 'gpt-6-astra'))
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'server_error')
  assert.match(finish.reason.failure.message, /upstream exploded/)
})

test('an incomplete response is reported as a token limit', async () => {
  const chunks = await collect(toResponsesChunks(sseBody([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message' } },
    { type: 'response.output_text.delta', output_index: 0, delta: 'partial' },
    { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
  ]), 'gpt-6-astra'))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
})

test('an empty completed response is an error, not a silent blank turn', async () => {
  const chunks = await collect(toResponsesChunks(sseBody([
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 0 } } },
  ]), 'gpt-6-astra'))
  assert.equal(chunks.at(-1).reason.kind, 'error')
  assert.equal(chunks.at(-1).reason.failure.code, 'EMPTY_RESPONSE')
})

test('usage maps the nested detail counters', () => {
  assert.deepEqual(responsesUsage({ input_tokens: 10, output_tokens: 2 }), { inputTokens: 10, outputTokens: 2 })
  assert.deepEqual(
    responsesUsage({ input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 1 } }),
    { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, reasoningTokens: 1 },
  )
})

test('the responses body carries instructions, input and Responses-style tools', () => {
  const body = buildResponsesBody({
    provider: 'deepaicode',
    model: 'auto',
    system: 'You are terse.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'list_directory', arguments: '{"path":"/x"}' }], source: { kind: 'model' } },
      { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'a.txt' }], source: { kind: 'tool' } },
    ],
    tools: [{ name: 'list_directory', description: 'List a directory.', parameters: { type: 'object', properties: {} } }],
    maxTokens: 100,
  }, 'gpt-6-astra')

  assert.equal(body.model, 'gpt-6-astra')
  assert.equal(body.instructions, 'You are terse.')
  assert.equal(body.stream, true)
  assert.equal(body.store, false)
  assert.equal('max_output_tokens' in body, false, 'upstream rejects that field with 400')
  assert.deepEqual(body.input[0], { role: 'user', content: [{ type: 'input_text', text: 'hi' }] })
  assert.deepEqual(body.input[1], { type: 'function_call', call_id: 'call_1', name: 'list_directory', arguments: '{"path":"/x"}' })
  assert.deepEqual(body.input[2], { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' })
  assert.deepEqual(body.tools, [{
    type: 'function',
    name: 'list_directory',
    description: 'List a directory.',
    parameters: { type: 'object', properties: {} },
  }])
})

test('a system message becomes instructions instead of an input item', () => {
  const body = buildResponsesBody({
    provider: 'deepaicode',
    model: 'auto',
    messages: [{ role: 'system', content: [{ type: 'text', text: 'From the log.' }], source: { kind: 'system-prompt' } }],
  }, 'gpt-6-astra')
  assert.equal(body.instructions, 'From the log.')
  assert.deepEqual(body.input, [])
})

test('a request with no system prompt still carries instructions', () => {
  const body = buildResponsesBody({ provider: 'deepaicode', model: 'auto', messages: [] }, 'gpt-6-astra')
  assert.equal(body.instructions, DEFAULT_SYSTEM_PROMPT)
})
