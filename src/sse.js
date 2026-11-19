/**
 * Server-Sent Events reader for the DeepAI Code streaming endpoints.
 *
 * The upstream `text/event-stream` body is decoded incrementally: `data:`
 * payloads are yielded as soon as a blank line terminates the frame, and the
 * optional `event:` name is preserved for the Responses endpoint, whose frames
 * are typed.
 *
 * The reader also owns the **idle watchdog**. A stream that opens successfully
 * and then stops producing frames looks exactly like a slow model, so without a
 * deadline a stalled connection would hang the turn forever instead of failing
 * over. Every read is raced against an idle timer; when the timer wins, the
 * stream is cancelled and a `StreamIdleError` is raised so the router classifies
 * the attempt as a transport failure.
 *
 * The body is consumed through an explicit reader rather than its async
 * iterator, because releasing an abandoned async iterator waits for the read
 * that was just abandoned and can therefore never settle. Cancelling a reader
 * resolves immediately and resolves the pending read with it.
 *
 * @module dsh-deepaicode-auto/sse
 */

/**
 * Raised when an event stream stopped producing frames past its idle deadline.
 *
 * Carries the `TIMEOUT` code the router classifies as a transient failure, which
 * is what makes a stalled stream fail over to another model.
 */
export class StreamIdleError extends Error {
  /**
   * @param {number} idleTimeoutMs - the deadline that expired.
   */
  constructor(idleTimeoutMs) {
    super(`the upstream event stream produced no frame for ${String(idleTimeoutMs)}ms`)
    this.name = 'StreamIdleError'
    this.code = 'TIMEOUT'
    this.idleTimeoutMs = idleTimeoutMs
  }
}

/**
 * @typedef {object} SseFrame
 * @property {string} [event] - the frame's `event:` name, when present.
 * @property {string} data - the concatenated `data:` payload.
 * @property {string} [id] - the frame's `id:` value, when present.
 */

/**
 * Race one read against the idle deadline.
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader - the body reader.
 * @param {number} idleTimeoutMs - deadline in milliseconds, or 0 to wait indefinitely.
 * @returns {Promise<ReadableStreamReadResult<Uint8Array>>} the next read.
 */
function readWithIdleDeadline(reader, idleTimeoutMs) {
  if (idleTimeoutMs <= 0) return reader.read()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new StreamIdleError(idleTimeoutMs))
    }, idleTimeoutMs)
    reader.read().then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Decode a byte stream into SSE frames.
 * @param {ReadableStream<Uint8Array>} body - the response body.
 * @param {AbortSignal} [signal] - cancellation for the read loop.
 * @param {number} [idleTimeoutMs] - deadline between two frames, or 0 to disable the watchdog.
 * @returns {AsyncGenerator<SseFrame>} the frames in arrival order.
 * @throws {StreamIdleError} when the watchdog expires.
 */
export async function* readSse(body, signal, idleTimeoutMs = 0) {
  const decoder = new TextDecoder('utf-8')
  const reader = body.getReader()
  let buffer = ''
  let eventName
  let eventId
  let dataLines = []

  const flush = () => {
    if (dataLines.length === 0 && eventName === undefined) return undefined
    const frame = { data: dataLines.join('\n') }
    if (eventName !== undefined) frame.event = eventName
    if (eventId !== undefined) frame.id = eventId
    eventName = undefined
    eventId = undefined
    dataLines = []
    return frame
  }

  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error('the stream was cancelled')
      const step = await readWithIdleDeadline(reader, idleTimeoutMs)
      if (step.done) break

      buffer += decoder.decode(step.value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const rawLine = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
        if (line === '') {
          const frame = flush()
          if (frame !== undefined) yield frame
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''))
        } else if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
        } else if (line.startsWith('id:')) {
          eventId = line.slice(3).trim()
        }
        newline = buffer.indexOf('\n')
      }
    }

    buffer += decoder.decode()
    if (buffer.length > 0) {
      const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
      else if (line.startsWith('event:')) eventName = line.slice(6).trim()
    }
    const last = flush()
    if (last !== undefined) yield last
  } finally {
    // Cancelling is what actually aborts an abandoned upstream request, so a
    // watchdog fire cannot leave a socket open.
    try {
      await reader.cancel()
    } catch {
      // The body was already closed or errored.
    }
  }
}

/**
 * Yield each SSE frame's JSON payload, passing non-JSON frames over silently.
 * @param {ReadableStream<Uint8Array>} body - the response body.
 * @param {AbortSignal} [signal] - cancellation for the read loop.
 * @param {number} [idleTimeoutMs] - deadline between two frames, or 0 to disable the watchdog.
 * @returns {AsyncGenerator<{event?: string, value: any, raw: string}>} decoded frames.
 */
export async function* readSseJson(body, signal, idleTimeoutMs = 0) {
  for await (const frame of readSse(body, signal, idleTimeoutMs)) {
    if (frame.data === '[DONE]') return
    if (frame.data.trim() === '') continue
    let value
    try {
      value = JSON.parse(frame.data)
    } catch {
      continue
    }
    yield { event: frame.event, value, raw: frame.data }
  }
}
