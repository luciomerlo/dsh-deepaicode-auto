/**
 * Request-shape construction for the DeepAI Code compatibility endpoints.
 *
 * Upstream rejects a body that does not look like the desktop client sends one
 * (`400 This request is not one DeepAI Code sends.`). The published workarounds
 * are: always carry a system message, and keep the exact desktop field set —
 * `store: false` and `stream_options` included.
 *
 * @module dsh-deepaicode-auto/body
 */

/** System prompt inserted when the caller supplied none. */
export const DEFAULT_SYSTEM_PROMPT = "You are a helpful AI assistant. Answer the user's request directly."

/**
 * Fields the desktop client sends, plus the sampling knobs a caller may set
 * explicitly. Anything else is dropped by the shape fallback.
 * @type {ReadonlySet<string>}
 */
export const DESKTOP_CHAT_KEYS = new Set([
  'model',
  'messages',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'stop',
  'stream',
  'stream_options',
  'store',
  'seed',
  'service_tier',
  'reasoning_effort',
  'prompt_cache_key',
])

/**
 * Collect the object-shaped content blocks of a message.
 * @param {unknown} content - a message's content field.
 * @returns {Array<Record<string, unknown>>} the blocks.
 */
function blocksOf(content) {
  return Array.isArray(content)
    ? content.filter(block => block !== null && typeof block === 'object')
    : []
}

/**
 * Concatenate a message's text blocks.
 * @param {Record<string, unknown>} message - one harness message.
 * @returns {string} its plain text.
 */
function flattenText(message) {
  return blocksOf(message.content)
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => String(block.text))
    .join('')
}

/**
 * Parse a tool-call argument payload into an object.
 * @param {unknown} raw - the harness `arguments` string, or an already-parsed object.
 * @returns {Record<string, unknown>} the parsed arguments, or an empty object.
 */
function parseArguments(raw) {
  if (raw !== null && typeof raw === 'object') return raw
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object') return parsed
    } catch {
      // A non-JSON argument string is preserved as an empty object rather than
      // failing the whole turn.
    }
  }
  return {}
}

/**
 * Read the tool-call id a tool-role message answers.
 * @param {Record<string, unknown>} message - one harness message.
 * @returns {string | undefined} the id, when the message is a tool result.
 */
function toolCallIdOf(message) {
  if (typeof message.toolCallId === 'string' && message.toolCallId !== '') return message.toolCallId
  if (typeof message.tool_call_id === 'string' && message.tool_call_id !== '') return message.tool_call_id
  const source = message.source
  if (source !== null && typeof source === 'object' && source.kind === 'tool'
    && typeof source.callId === 'string' && source.callId !== '') return source.callId
  return undefined
}

/**
 * Project harness messages onto OpenAI chat messages.
 *
 * The harness keeps tool calls as `tool-call` content blocks on the assistant
 * message and answers them with `role: 'tool'` messages carrying a camelCase
 * `toolCallId`. OpenAI expects the calls as an assistant `tool_calls` array and
 * the answers keyed by `tool_call_id`.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} messages - harness request messages.
 * @returns {Array<Record<string, unknown>>} OpenAI-shaped messages.
 */
export function toOpenAIMessages(messages) {
  const out = []

  for (const message of messages) {
    if (message.role === 'assistant') {
      const text = []
      const toolCalls = []
      let reasoning = ''
      for (const block of blocksOf(message.content)) {
        if (block.type === 'text' && typeof block.text === 'string') {
          text.push(block.text)
        } else if (block.type === 'reasoning' && typeof block.text === 'string') {
          reasoning += block.text
        } else if (block.type === 'tool-call') {
          const id = typeof block.id === 'string' ? block.id : ''
          const name = typeof block.name === 'string' ? block.name : ''
          if (id === '' || name === '') continue
          toolCalls.push({ id, type: 'function', function: { name, arguments: JSON.stringify(parseArguments(block.arguments)) } })
        }
      }
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const id = typeof call?.id === 'string' ? call.id : ''
        const name = typeof call?.function?.name === 'string' ? call.function.name : ''
        if (id === '' || name === '') continue
        toolCalls.push({ id, type: 'function', function: { name, arguments: JSON.stringify(parseArguments(call.function?.arguments)) } })
      }
      const joined = text.join('')
      const assistant = { role: 'assistant' }
      // OpenAI requires `null` content when the turn is tool calls only.
      assistant.content = joined !== '' ? joined : toolCalls.length > 0 ? null : ''
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls
      if (reasoning !== '') assistant.reasoning_content = reasoning
      out.push(assistant)
      continue
    }

    const callId = toolCallIdOf(message)
    if (callId !== undefined) {
      const text = flattenText(message)
      out.push({
        role: 'tool',
        tool_call_id: callId,
        content: text !== '' ? text : '(no output)',
        ...(message.isError === true ? { is_error: true } : {}),
      })
      continue
    }

    const parts = []
    for (const block of blocksOf(message.content)) {
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push({ type: 'text', text: block.text })
      } else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
        parts.push({ type: 'image_url', image_url: { url: `data:${block.mimeType};base64,${block.data}` } })
      }
    }

    const role = message.role === 'system' ? 'system' : message.role === 'developer' ? 'developer' : 'user'
    if (parts.length === 0) out.push({ role, content: '' })
    else if (parts.length === 1 && parts[0].type === 'text') out.push({ role, content: parts[0].text })
    else out.push({ role, content: parts })
  }

  return out
}

/**
 * Whether a message list already carries a system or developer message.
 * @param {ReadonlyArray<Record<string, unknown>>} messages - OpenAI-shaped messages.
 * @returns {boolean} true when one is present.
 */
export function hasSystemMessage(messages) {
  return messages.some(message => message.role === 'system' || message.role === 'developer')
}

/**
 * Build a `chat/completions` request body in the desktop client's field order.
 * @param {object} options - the adapter's generate options.
 * @param {string} model - the upstream model id.
 * @returns {Record<string, unknown>} the request body.
 */
export function buildChatBody(options, model) {
  const messages = toOpenAIMessages(options.messages ?? [])

  const system = typeof options.system === 'string' && options.system !== '' ? options.system : undefined
  if (!hasSystemMessage(messages)) {
    messages.unshift({ role: 'system', content: system ?? DEFAULT_SYSTEM_PROMPT })
  }

  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    store: false,
  }

  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.parameters ?? { type: 'object', properties: {} },
      },
    }))
    body.parallel_tool_calls = true
  }
  if (options.maxTokens !== undefined) body.max_completion_tokens = options.maxTokens
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop

  // A reasoning model must be told the effort explicitly: omitting the field is
  // silently downgraded upstream, and "off" is spelled "none".
  if (typeof options.reasoningEffort === 'string' && options.reasoningEffort !== '') {
    body.reasoning_effort = options.reasoningEffort === 'off' ? 'none' : options.reasoningEffort
  }

  if (typeof options.sessionId === 'string' && options.sessionId !== '') {
    body.prompt_cache_key = options.sessionId
  }

  return body
}

/**
 * Collapse a rejected body onto the desktop field whitelist.
 * @param {Record<string, unknown>} body - the body upstream rejected.
 * @param {string} [system] - the system prompt to insert when one is missing.
 * @returns {Record<string, unknown> | undefined} the corrected body, or undefined when it cannot be corrected.
 */
export function chatBodyFallback(body, system) {
  const messages = body.messages
  if (!Array.isArray(messages) || messages.length === 0) return undefined

  const strict = {}
  for (const [key, value] of Object.entries(body)) {
    if (DESKTOP_CHAT_KEYS.has(key)) strict[key] = value
  }

  if (!hasSystemMessage(messages)) {
    strict.messages = [{ role: 'system', content: system ?? DEFAULT_SYSTEM_PROMPT }, ...messages]
  }
  return strict
}
