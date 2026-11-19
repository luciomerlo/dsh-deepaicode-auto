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
