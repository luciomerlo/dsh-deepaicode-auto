/**
 * Translation from the upstream OpenAI-compatible SSE stream into DeepSeek
 * Harness `StreamChunk`s.
 *
 * Two invariants matter and are easy to break:
 *  - block indices are a single global counter, because the Harness assembler
 *    treats one index as one block identity. Counting text and reasoning
 *    separately makes a "think first, then answer" turn collide on index 0 and
 *    silently drop the answer;
 *  - a tool call does not close an open text block, because models interleave
 *    prose and tool calls and closing early splits one paragraph into several
 *    blocks. Only `block-start`/`block-end` pairing is mandatory.
 *
 * @module dsh-deepaicode-auto/stream
 */

import { readSseJson } from './sse.js'

/**
 * Read the text and reasoning deltas of one upstream chunk.
 * @param {any} chunk - one decoded SSE object.
 * @returns {{content: string, reasoning: string, toolCalls: Array<{index: number, id: string, name: string, args: string}>, finish: string}} the parts.
 */
export function chatChunkDelta(chunk) {
  const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined
  const delta = choice?.delta ?? {}
  const toolCalls = []
  for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
    toolCalls.push({
      index: typeof call?.index === 'number' ? call.index : 0,
      id: typeof call?.id === 'string' ? call.id : '',
      name: typeof call?.function?.name === 'string' ? call.function.name : '',
      args: typeof call?.function?.arguments === 'string' ? call.function.arguments : '',
    })
  }
  return {
    content: typeof delta.content === 'string' ? delta.content : '',
    reasoning: typeof delta.reasoning_content === 'string'
      ? delta.reasoning_content
      : typeof delta.reasoning === 'string' ? delta.reasoning : '',
    toolCalls,
    finish: typeof choice?.finish_reason === 'string' ? choice.finish_reason : '',
  }
}

/**
 * Read the usage block of one upstream chunk.
 * @param {any} chunk - one decoded SSE object.
 * @returns {{inputTokens: number, outputTokens: number, cacheReadTokens?: number, reasoningTokens?: number} | undefined} usage, when present.
 */
export function chatChunkUsage(chunk) {
  const usage = chunk?.usage
  if (usage === null || typeof usage !== 'object') return undefined
  const input = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0
  const output = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0
  const result = { inputTokens: input, outputTokens: output }
  const cached = usage.prompt_tokens_details?.cached_tokens
  if (typeof cached === 'number' && cached > 0) result.cacheReadTokens = cached
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  if (typeof reasoning === 'number' && reasoning > 0) result.reasoningTokens = reasoning
  return result
}

/**
 * Map an upstream `finish_reason` onto the harness finish reason.
 * @param {string} finish - upstream reason.
 * @param {boolean} sawToolCall - whether the turn emitted a tool call.
 * @returns {object} the harness finish reason.
 */
export function finishReasonOf(finish, sawToolCall) {
  if (sawToolCall && (finish === '' || finish === 'tool_calls' || finish === 'stop')) return { kind: 'tool-calls' }
  if (finish === 'length') return { kind: 'max-tokens' }
  if (finish === 'tool_calls') return { kind: 'tool-calls' }
  if (finish === 'content_filter') {
    return { kind: 'error', failure: { message: 'the upstream provider filtered this response', code: 'CONTENT_FILTERED' } }
  }
  return { kind: 'stop' }
}

/**
 * Translate one upstream SSE body into harness chunks.
 * @param {ReadableStream<Uint8Array>} body - the upstream response body.
 * @param {string} model - the model id, for diagnostics.
 * @param {AbortSignal} [signal] - cancellation.
 * @param {{idleTimeoutMs?: number}} [hooks] - stream watchdog deadline (0 or absent disables it).
 * @returns {AsyncGenerator<object>} the harness chunks, ending in one `finish`.
 */
export async function* toStreamChunks(body, model, signal, hooks = {}) {
  let nextIndex = 0
  let textIndex = -1
  let reasoningIndex = -1
  let textOpen = false
  let reasoningOpen = false
  const textBuffer = new Map()
  const reasoningBuffer = new Map()
  /** @type {Map<number, {id: string, name: string, args: string}>} */
  const toolCalls = new Map()
  /** @type {Map<number, number>} */
  const toolIndexes = new Map()
  let sawToolCall = false
  let finish = ''
  let usage
  /** @type {{message: string, code: string} | undefined} */
  let upstreamError

  const emit = (chunk) => chunk

  for await (const frame of readSseJson(body, signal, hooks.idleTimeoutMs ?? 0)) {
    const chunk = frame.value
    if (chunk === null || typeof chunk !== 'object') continue

    // Upstream occasionally reports a failure inside an otherwise healthy SSE body.
    if (chunk.error !== null && typeof chunk.error === 'object') {
      upstreamError = {
        message: typeof chunk.error.message === 'string' ? chunk.error.message : `${model}: upstream reported an error mid-stream`,
        code: typeof chunk.error.code === 'string' ? chunk.error.code : 'UPSTREAM',
      }
      break
    }

    const delta = chatChunkDelta(chunk)
    if (delta.finish !== '') finish = delta.finish
    const frameUsage = chatChunkUsage(chunk)
    if (frameUsage !== undefined) usage = frameUsage

    if (delta.reasoning !== '') {
      if (!reasoningOpen) {
        reasoningIndex = nextIndex
        nextIndex += 1
        reasoningOpen = true
        yield emit({ type: 'block-start', index: reasoningIndex, blockType: 'reasoning' })
      }
      reasoningBuffer.set(reasoningIndex, (reasoningBuffer.get(reasoningIndex) ?? '') + delta.reasoning)
      yield emit({ type: 'reasoning-delta', index: reasoningIndex, text: delta.reasoning })
    }

    if (delta.content !== '') {
      if (reasoningOpen) {
        reasoningOpen = false
        yield emit({ type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningBuffer.get(reasoningIndex) ?? '' } })
      }
      if (!textOpen) {
        textIndex = nextIndex
        nextIndex += 1
        textOpen = true
        yield emit({ type: 'block-start', index: textIndex, blockType: 'text' })
      }
      textBuffer.set(textIndex, (textBuffer.get(textIndex) ?? '') + delta.content)
      yield emit({ type: 'text-delta', index: textIndex, text: delta.content })
    }

    for (const call of delta.toolCalls) {
      let slot = toolCalls.get(call.index)
      if (slot === undefined) {
        slot = { id: '', name: '', args: '' }
        toolCalls.set(call.index, slot)
        toolIndexes.set(call.index, nextIndex)
        nextIndex += 1
        sawToolCall = true
        yield emit({ type: 'block-start', index: toolIndexes.get(call.index), blockType: 'tool-call' })
      }
      if (call.id !== '') slot.id = call.id
      if (call.name !== '') slot.name = call.name
      slot.args += call.args
      yield emit({
        type: 'tool-call-delta',
        index: toolIndexes.get(call.index),
        id: slot.id,
        ...(slot.name !== '' ? { name: slot.name } : {}),
        argumentsDelta: call.args,
      })
    }
  }

  // Close every block this turn opened; an unpaired block-start would leave the
  // assembler waiting for it forever.
  if (reasoningOpen) {
    yield emit({ type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningBuffer.get(reasoningIndex) ?? '' } })
  }
  if (textOpen) {
    yield emit({ type: 'block-end', index: textIndex, block: { type: 'text', text: textBuffer.get(textIndex) ?? '' } })
  }
  for (const [index, slot] of toolCalls) {
    yield emit({ type: 'block-end', index: toolIndexes.get(index), block: { type: 'tool-call', id: slot.id, name: slot.name, arguments: slot.args } })
  }

  if (usage !== undefined) yield emit({ type: 'usage', usage })

  if (upstreamError !== undefined) {
    yield emit({ type: 'finish', reason: { kind: 'error', failure: upstreamError } })
    return
  }

  const unnamed = [...toolCalls.values()].filter(slot => slot.name.trim() === '').length
  if (unnamed > 0) {
    yield emit({
      type: 'finish',
      reason: { kind: 'error', failure: { message: `${model}: upstream returned ${String(unnamed)} unnamed tool call(s)`, code: 'UNNAMED_TOOL_CALL' } },
    })
    return
  }

  const said = [...textBuffer.values()].join('') + [...reasoningBuffer.values()].join('')
  if (said.trim() === '' && !sawToolCall && finish !== 'length') {
    yield emit({
      type: 'finish',
      reason: { kind: 'error', failure: { message: `${model}: upstream returned an empty response`, code: 'EMPTY_RESPONSE' } },
    })
    return
  }

  yield emit({ type: 'finish', reason: finishReasonOf(finish, sawToolCall) })
}

/**
 * Map the Responses API usage block onto harness token counts.
 * @param {any} usage - the `usage` object of a terminal response event.
 * @returns {object} harness usage.
 */
export function responsesUsage(usage) {
  const inputTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0
  const outputTokens = typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0
  const result = { inputTokens, outputTokens }
  const cached = usage?.input_tokens_details?.cached_tokens
  if (typeof cached === 'number' && cached > 0) result.cacheReadTokens = cached
  const reasoning = usage?.output_tokens_details?.reasoning_tokens
  if (typeof reasoning === 'number' && reasoning > 0) result.reasoningTokens = reasoning
  return result
}

/**
 * Translate one `/responses` SSE body into harness chunks.
 *
 * The Responses API streams typed events rather than chat deltas: an item is
 * announced with `response.output_item.added`, its text or function arguments
 * arrive as `*.delta` events, and it closes with `response.output_item.done`.
 * Output items are keyed by `output_index`, which this maps onto the harness's
 * single global block index.
 *
 * @param {ReadableStream<Uint8Array>} body - the upstream response body.
 * @param {string} model - the model id, for diagnostics.
 * @param {AbortSignal} [signal] - cancellation.
 * @param {{idleTimeoutMs?: number}} [hooks] - stream watchdog deadline (0 or absent disables it).
 * @returns {AsyncGenerator<object>} the harness chunks, ending in one `finish`.
 */
export async function* toResponsesChunks(body, model, signal, hooks = {}) {
  let nextIndex = 0
  /** @type {Map<number, {index: number, kind: 'text' | 'reasoning' | 'tool', id: string, name: string, text: string, args: string, closed: boolean}>} */
  const slots = new Map()
  let sawToolCall = false
  let usage
  /** @type {{message: string, code: string} | undefined} */
  let failure
  let status = 'completed'

  /**
   * Open one block for an output item, idempotently.
   * @param {number} outputIndex - the item's `output_index`.
   * @param {'text' | 'reasoning' | 'tool'} kind - block kind.
   * @param {{id?: string, name?: string}} [item] - the item announced by the event.
   * @returns {any} the block slot.
   */
  const open = (outputIndex, kind, item = {}) => {
    let slot = slots.get(outputIndex)
    if (slot !== undefined) return slot
    slot = { index: nextIndex, kind, id: item.id ?? '', name: item.name ?? '', text: '', args: '', closed: false }
    nextIndex += 1
    slots.set(outputIndex, slot)
    if (kind === 'tool') sawToolCall = true
    return slot
  }

  for await (const frame of readSseJson(body, signal, hooks.idleTimeoutMs ?? 0)) {
    const event = frame.value
    if (event === null || typeof event !== 'object') continue
    const type = typeof event.type === 'string' ? event.type : ''

    if (type === 'response.output_item.added') {
      const item = event.item ?? {}
      if (item.type === 'function_call') {
        const slot = open(event.output_index ?? 0, 'tool', { id: item.call_id ?? '', name: item.name ?? '' })
        yield { type: 'block-start', index: slot.index, blockType: 'tool-call' }
      } else if (item.type === 'reasoning') {
        const slot = open(event.output_index ?? 0, 'reasoning')
        yield { type: 'block-start', index: slot.index, blockType: 'reasoning' }
      } else {
        const slot = open(event.output_index ?? 0, 'text')
        yield { type: 'block-start', index: slot.index, blockType: 'text' }
      }
      continue
    }

    if (type === 'response.output_text.delta') {
      const slot = open(event.output_index ?? 0, 'text')
      const delta = typeof event.delta === 'string' ? event.delta : ''
      if (delta !== '') {
        slot.text += delta
        yield { type: 'text-delta', index: slot.index, text: delta }
      }
      continue
    }

    if (type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') {
      const slot = open(event.output_index ?? 0, 'reasoning')
      const delta = typeof event.delta === 'string' ? event.delta : ''
      if (delta !== '') {
        slot.text += delta
        yield { type: 'reasoning-delta', index: slot.index, text: delta }
      }
      continue
    }

    if (type === 'response.function_call_arguments.delta') {
      const slot = open(event.output_index ?? 0, 'tool')
      const delta = typeof event.delta === 'string' ? event.delta : ''
      slot.args += delta
      yield {
        type: 'tool-call-delta',
        index: slot.index,
        id: slot.id,
        ...(slot.name !== '' ? { name: slot.name } : {}),
        argumentsDelta: delta,
      }
      continue
    }

    if (type === 'response.function_call_arguments.done') {
      const slot = open(event.output_index ?? 0, 'tool')
      if (typeof event.arguments === 'string') slot.args = event.arguments
      continue
    }

    if (type === 'response.output_text.done') {
      const slot = open(event.output_index ?? 0, 'text')
      if (typeof event.text === 'string') slot.text = event.text
      continue
    }

    if (type === 'response.output_item.done') {
      const item = event.item ?? {}
      const slot = open(event.output_index ?? 0, item.type === 'function_call' ? 'tool' : item.type === 'reasoning' ? 'reasoning' : 'text')
      if (slot.closed) continue
      slot.closed = true
      if (slot.kind === 'tool') {
        if (typeof item.call_id === 'string' && item.call_id !== '') slot.id = item.call_id
        if (typeof item.name === 'string' && item.name !== '') slot.name = item.name
        if (typeof item.arguments === 'string' && item.arguments !== '') slot.args = item.arguments
        yield { type: 'block-end', index: slot.index, block: { type: 'tool-call', id: slot.id, name: slot.name, arguments: slot.args } }
      } else if (slot.kind === 'reasoning') {
        yield { type: 'block-end', index: slot.index, block: { type: 'reasoning', text: slot.text } }
      } else {
        yield { type: 'block-end', index: slot.index, block: { type: 'text', text: slot.text } }
      }
      continue
    }

    if (type === 'response.completed' || type === 'response.incomplete') {
      const response = event.response ?? {}
      if (typeof response.status === 'string') status = response.status
      if (response.usage !== undefined) usage = responsesUsage(response.usage)
      continue
    }

    if (type === 'response.failed' || type === 'error') {
      const error = event.response?.error ?? event.error ?? event
      failure = {
        message: typeof error?.message === 'string' ? error.message : `${model}: the upstream response failed`,
        code: typeof error?.code === 'string' ? error.code : 'UPSTREAM',
      }
      continue
    }
  }

  // Close every block that is still open; an unpaired block-start would leave
  // the assembler waiting for it forever.
  for (const slot of slots.values()) {
    if (slot.closed) continue
    slot.closed = true
    if (slot.kind === 'tool') {
      yield { type: 'block-end', index: slot.index, block: { type: 'tool-call', id: slot.id, name: slot.name, arguments: slot.args } }
    } else if (slot.kind === 'reasoning') {
      yield { type: 'block-end', index: slot.index, block: { type: 'reasoning', text: slot.text } }
    } else {
      yield { type: 'block-end', index: slot.index, block: { type: 'text', text: slot.text } }
    }
  }

  if (usage !== undefined) yield { type: 'usage', usage }

  if (failure !== undefined) {
    yield { type: 'finish', reason: { kind: 'error', failure } }
    return
  }

  const unnamed = [...slots.values()].filter(slot => slot.kind === 'tool' && slot.name.trim() === '').length
  if (unnamed > 0) {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { message: `${model}: upstream returned ${String(unnamed)} unnamed tool call(s)`, code: 'UNNAMED_TOOL_CALL' } },
    }
    return
  }

  const said = [...slots.values()].filter(slot => slot.kind !== 'tool').map(slot => slot.text).join('')
  if (said.trim() === '' && !sawToolCall && status !== 'incomplete') {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { message: `${model}: upstream returned an empty response`, code: 'EMPTY_RESPONSE' } },
    }
    return
  }

  if (status === 'incomplete') {
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
    return
  }
  yield { type: 'finish', reason: sawToolCall ? { kind: 'tool-calls' } : { kind: 'stop' } }
}
