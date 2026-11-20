/**
 * The `llm`-service adapter: a duck-typed implementation of the harness
 * `LlmAdapter` contract that also owns the Auto (DeepAiCode) routing.
 *
 * The adapter deliberately imports nothing from `@deepseek-ai/*`. Registering a
 * route only validates `providerInfo` and `providerRetryPolicy`, so an ordinary
 * object is accepted — but the runtime later calls the **whole** contract
 * (`imageRequestPricing`, `imageRequestTarget`, `listModels`, `resolveModel`,
 * `prepareCall`, `stream`). Every member must therefore exist: a missing one
 * surfaces far from registration, for example as
 * `imageRequestPricing is not a function` when a model switch compacts the
 * conversation. `test/adapter.test.js` asserts the full member list.
 *
 * @module dsh-deepaicode-auto/adapter
 */

import { buildLadder, modelBadge } from './models.js'
import { toResponsesChunks, toStreamChunks } from './stream.js'
import { UpstreamError } from './client.js'
import { classifyFailure } from './router.js'

/** Provider route this adapter owns. */
export const PROVIDER_ID = 'deepaicode'

/** Model id of the virtual routing model. */
export const AUTO_ID = 'auto'

/**
 * The routing policy handed to the harness retry layer.
 *
 * Failover is the adapter's job, so harness-level retries would duplicate work
 * and could replay a request against a model the router had already retired.
 * @returns {object} a normal policy with no retries.
 */
export function noHarnessRetryPolicy() {
  return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 }
}

/**
 * Coerce an arbitrary thrown value into the failure facts the router classifies.
 * @param {unknown} error - the thrown value.
 * @param {AbortSignal} [signal] - the caller's signal.
 * @returns {{status?: number, code?: string, message?: string}} failure facts.
 */
export function factsOf(error, signal) {
  if (error instanceof UpstreamError) {
    return { status: error.status, code: error.code, message: error.message }
  }
  if (error !== null && typeof error === 'object') {
    const anyError = /** @type {any} */ (error)
    if (anyError.name === 'AbortError' || signal?.aborted === true) {
      return { code: 'ABORTED', message: 'the request was cancelled' }
    }
    if (anyError.failure !== undefined && typeof anyError.failure === 'object') {
      return { code: anyError.failure.code, message: anyError.failure.message, status: anyError.failure.status }
    }
    if (typeof anyError.code === 'string') {
      const status = typeof anyError.status === 'number' ? anyError.status : undefined
      return { status, code: anyError.code, message: anyError.message }
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { code: /timeout|timed out/i.test(message) ? 'TIMEOUT' : 'TRANSPORT', message }
}

/**
 * Wrap a terminal stream failure so the routing loop can classify it.
 */
class StreamFailure extends Error {
  /**
   * @param {{message: string, code: string, status?: number}} failure - the terminal failure.
   */
  constructor(failure) {
    super(failure.message)
    this.name = 'StreamFailure'
    this.failure = failure
  }
}

/**
 * Rewrite a failure to the canonical code the harness acts on.
 *
 * Upstream reports an oversized conversation as `400 context_length_exceeded`.
 * The harness only condenses the conversation and retries when it sees its own
 * `CONTEXT_WINDOW_EXCEEDED` code, so that mapping is what turns a dead end into
 * an automatic recovery.
 *
 * @param {{message: string, code: string, status?: number}} failure - the observed failure.
 * @returns {{message: string, code: string, status?: number}} the failure to report.
 */
export function canonicalFailure(failure) {
  if (classifyFailure(failure) === 'context') return { ...failure, code: 'CONTEXT_WINDOW_EXCEEDED' }
  return failure
}

/**
 * @typedef {object} AdapterParts
 * @property {import('./router.js').AutoRouter} router - routing policy.
 * @property {import('./client.js').DeepAiClient} client - upstream client.
 * @property {import('./catalog.js').ModelCatalog} catalog - model catalog.
 * @property {Record<string, any>} config - resolved plugin config.
 * @property {{info: Function, warn: Function, debug: Function}} logger - diagnostics sink.
 */

/**
 * Build the adapter the `llm` service registers for this provider.
 * @param {AdapterParts} parts - the plugin's shared collaborators.
 * @returns {object} the duck-typed adapter.
 */
export function createAdapter(parts) {
  const { router, client, catalog, config, logger } = parts
  const autoId = config.autoModelId
  let lastQuotaReadAt = 0

  /**
   * Rebuild the router ladder from the current config and catalog.
   * @returns {object} the ladder just installed.
   */
  function refreshLadder() {
    const ladder = buildLadder(config, catalog.list(), { authoritative: catalog.live })
    router.setLadder(ladder)
    return ladder
  }

  // The catalog starts on the published table, so the ladder is complete before
  // the first request and the status surface is meaningful from the start.
  refreshLadder()

  /**
   * Read the allowance at most once per minute and hand it to the router.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<void>} resolves when the attempt has been made.
   */
  async function syncQuota(signal) {
    if (Date.now() - lastQuotaReadAt < 60_000) return
    lastQuotaReadAt = Date.now()
    try {
      const allowance = await client.ensureCheckIn(signal)
      if (allowance === undefined) return
      if (typeof allowance.balance === 'number' || typeof allowance.granted === 'number') {
        router.setQuota(allowance.balance ?? null, allowance.granted)
        logger.debug(`deepaicode: allowance ${String(allowance.balance)} / ${String(allowance.granted)} Theos`)
      }
    } catch (error) {
      logger.debug('deepaicode: allowance probe failed', error)
    }
  }

  /**
   * Refresh the catalog after a model failure, without blocking the fallback.
   * @returns {void}
   */
  function refreshCatalogInBackground() {
    if (config.refreshCatalogOnError !== true) return
    void catalog.refresh({ force: true }).then(() => {
      refreshLadder()
    }).catch(() => {})
  }

  /**
   * Run one model attempt and translate its stream.
   * @param {object} options - the harness generate options.
   * @param {{id: string, api: string}} candidate - the model to call.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {AsyncGenerator<object>} harness chunks.
   */
  async function* attempt(options, candidate, signal) {
    const response = await client.openStream(options, { model: candidate.id, api: candidate.api }, signal)
    const hooks = { idleTimeoutMs: config.streamIdleTimeoutMs }
    // Each endpoint family has its own wire vocabulary: chat deltas versus typed
    // Responses events. Translating with the wrong one yields an empty turn.
    yield* candidate.api === 'openai-responses'
      ? toResponsesChunks(response.body, candidate.id, signal, hooks)
      : toStreamChunks(response.body, candidate.id, signal, hooks)
  }

  /**
   * Walk one ordered attempt chain, failing over only while nothing has been
   * shown to the user yet.
   *
   * A failure before the first block is safe to replay against another model;
   * a failure after it is not, because already-emitted text cannot be unsent.
   *
   * @param {object} options - the harness generate options.
   * @param {object[]} plan - the ordered models to try.
   * @param {string} label - what the caller asked for, used in the terminal message.
   * @returns {AsyncGenerator<object>} harness chunks.
   */
  async function* runChain(options, plan, label) {
    const signal = options.signal
    await syncQuota(signal)

    /** Models already attempted for this request. */
    const tried = new Set()
    /** Frontier attempts spent so far in this request. */
    let frontierTries = 0
    /**
     * Ask the router again, minus what this request already tried.
     *
     * Re-planning after every failure is what makes an exhausted allowance
     * collapse the paid tier at once: the balance drops to zero, the next plan
     * holds only unmetered models, and the free tier is reached instead of
     * repeating the same 403 on every Frontier rung.
     *
     * The paid-attempt budget is enforced here, not only inside `plan()`, because
     * each replan would otherwise hand out a fresh allowance of Frontier rungs.
     */
    const pending = () => router.plan().filter(rung => {
      if (tried.has(rung.id)) return false
      if (rung.tier === 'frontier' && frontierTries >= config.maxFailovers) return false
      return true
    })

    plan = plan.filter(rung => !tried.has(rung.id))
    if (plan.length === 0) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: `${label}: every model is cooling down or out of allowance`, code: 'NO_MODEL_AVAILABLE' },
        },
      }
      return
    }

    // A hard ceiling keeps a provider whose failures never cool a model down
    // from looping this request forever.
    const ceiling = config.maxFailovers + router.ladder.unmetered.length + 1

    for (let round = 1; round <= ceiling && plan.length > 0; round += 1) {
      const candidate = plan[0]
      tried.add(candidate.id)
      if (candidate.tier === 'frontier') frontierTries += 1
      if (signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'the request was cancelled', code: 'ABORTED' } } }
        return
      }

      let emitted = false
      /** @type {{message: string, code: string, status?: number} | undefined} */
      let terminal
      try {
        for await (const chunk of attempt(options, candidate, signal)) {
          if (chunk.type === 'finish' && chunk.reason.kind === 'error' && !emitted) {
            terminal = chunk.reason.failure
            break
          }
          if (chunk.type !== 'finish') emitted = true
          yield chunk
          if (chunk.type === 'finish') {
            if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
              // Already-visible output cannot be replayed against another model.
              router.recordFailure(candidate, chunk.reason.failure)
              refreshCatalogInBackground()
              return
            }
            router.recordSuccess(candidate)
            logger.debug(`deepaicode: ${label} served ${modelBadge(candidate)} via ${candidate.label}`)
            return
          }
        }
      } catch (error) {
        terminal = factsOf(error, signal)
      }

      if (terminal === undefined) {
        // The attempt ended without a finish chunk: treat it as a transport cut.
        terminal = { code: 'STREAM_CLOSED', message: `${candidate.id}: the stream ended without a terminal chunk` }
      }

      const reaction = router.recordFailure(candidate, terminal)
      if (reaction === 'auth') {
        yield { type: 'finish', reason: { kind: 'error', failure: terminal } }
        return
      }
      if (signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'the request was cancelled', code: 'ABORTED' } } }
        return
      }
      if (emitted) {
        // Output is already on screen; a different model cannot continue it.
        yield { type: 'finish', reason: { kind: 'error', failure: terminal } }
        return
      }

      if (reaction === 'context') {
        // The model is healthy; this conversation is simply bigger than it can
        // hold. Only a model with a wider window can help — anything narrower
        // fails identically — and when none is left the canonical overflow code
        // lets the harness condense the conversation and retry.
        const wider = pending().filter(rung => (rung.contextWindow ?? 0) > (candidate.contextWindow ?? 0))
        if (wider.length === 0) {
          router.recordHandoff(candidate.id, 'none', 'context')
          logger.warn(`deepaicode: ${candidate.id} reports the conversation exceeds its window; asking the harness to compact`)
          yield { type: 'finish', reason: { kind: 'error', failure: canonicalFailure(terminal) } }
          return
        }
        router.recordHandoff(candidate.id, wider[0].id, 'context')
        logger.warn(`deepaicode: ${candidate.id} cannot hold this conversation; trying the wider ${wider[0].id}`)
        plan = wider
        continue
      }

      const rest = pending()
      router.recordHandoff(candidate.id, rest[0]?.id ?? 'none', reaction)
      logger.warn(
        `deepaicode: ${candidate.id} failed (${reaction}: ${terminal.code ?? 'unknown'}); `
        + `${rest[0] === undefined ? 'no model left' : `switching to ${rest[0].id}`}`,
      )
      refreshCatalogInBackground()
      if (rest.length === 0) {
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { ...terminal, message: `${label} exhausted every model: ${terminal.message ?? ''}` } },
        }
        return
      }
      plan = rest
    }

    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: `${label}: gave up after ${String(tried.size)} model attempt(s)`, code: 'NO_MODEL_AVAILABLE' },
      },
    }
  }

  /**
   * Stream one call for an explicitly selected model.
   *
   * By default an explicit choice is honoured exactly: a failure is reported
   * rather than silently spending Theos on a different model. Setting
   * `failoverExplicitModels` opts into continuing on the ladder instead.
   *
   * @param {object} options - the harness generate options.
   * @param {object} candidate - the selected model's ladder rung.
   * @returns {AsyncGenerator<object>} harness chunks.
   */
  async function* streamExplicit(options, candidate) {
    if (config.failoverExplicitModels === true) {
      const rest = router.plan().filter(rung => rung.id !== candidate.id)
      const chain = router.blockedReason(candidate.id) === undefined ? [candidate, ...rest] : rest
      yield* runChain(options, chain, candidate.label)
      return
    }
    const signal = options.signal
    await syncQuota(signal)
    let emitted = false
    try {
      for await (const chunk of attempt(options, candidate, signal)) {
        // Normalize an overflow to the code the harness recovers from, before
        // the terminal chunk leaves this adapter.
        const out = chunk.type === 'finish' && chunk.reason.kind === 'error'
          ? { ...chunk, reason: { ...chunk.reason, failure: canonicalFailure(chunk.reason.failure) } }
          : chunk
        if (out.type !== 'finish') emitted = true
        yield out
        if (out.type === 'finish') {
          if (out.reason.kind === 'error' || out.reason.kind === 'aborted') {
            router.recordFailure(candidate, out.reason.failure)
            refreshCatalogInBackground()
          } else {
            router.recordSuccess(candidate)
          }
          return
        }
      }
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: `${candidate.id}: the stream ended without a terminal chunk`, code: 'STREAM_CLOSED' },
        },
      }
    } catch (error) {
      const facts = factsOf(error, signal)
      router.recordFailure(candidate, facts)
      refreshCatalogInBackground()
      if (signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'the request was cancelled', code: 'ABORTED' } } }
        return
      }
      if (error instanceof UpstreamError && error.laneUnsupported) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: facts.message ?? '', code: 'LANE_UNSUPPORTED' } } }
        return
      }
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: canonicalFailure({
            message: facts.message ?? 'upstream failure',
            code: facts.code ?? 'TRANSPORT',
            ...(facts.status === undefined ? {} : { status: facts.status }),
          }),
        },
      }
    }
  }

  /**
   * Resolve the ladder rung for one model id.
   * @param {string} modelId - the requested model id.
   * @returns {object | undefined} the rung, when the id names a known model.
   */
  function rungOf(modelId) {
    const ladder = router.ladder
    return ladder.frontier.find(model => model.id === modelId)
      ?? ladder.unmetered.find(model => model.id === modelId)
  }

  const adapter = {
    /**
     * @param {string} provider - the route this adapter owns.
     * @returns {{id: string, name: string}} provider metadata.
     */
    providerInfo(provider) {
      return { id: provider, name: 'DeepAI Code' }
    },

    /**
     * @returns {object} the retry policy the harness should apply.
     */
    providerRetryPolicy() {
      return noHarnessRetryPolicy()
    },

    /**
     * Declare provider-side image request pricing for one route.
     *
     * This client never sends images upstream, so it declares none and the token
     * meter falls back to its own neutral estimate. The method must exist: the
     * meter calls it per measurement, and a compaction that switches models
     * calls it before any request is made.
     *
     * @param {string} _provider - the route.
     * @param {string} _model - the model id.
     * @returns {undefined} no provider-side pricing.
     */
    imageRequestPricing(_provider, _model) {
      return undefined
    },

    /**
     * @param {string} _provider - the route.
     * @param {string} _model - the model id.
     * @param {{width: number, height: number, bytes: number}} image - the normalized image.
     * @returns {{width: number, height: number, maxBytes: number}} the request projection.
     */
    imageRequestTarget(_provider, _model, image) {
      return { width: image.width, height: image.height, maxBytes: image.bytes }
    },

    /**
     * Advertise the virtual Auto model plus every real model on the ladder.
     * @returns {Promise<object[]>} the selector catalog.
     */
    async listModels() {
      const ladder = refreshLadder()
      const models = [{
        provider: PROVIDER_ID,
        id: autoId,
        name: config.autoModelName,
        description: 'Frontier models first, unmetered models when the daily Theos allowance is spent or a model fails.',
        inputModalities: ['text'],
        badge: { text: 'Smart router', tone: 'info' },
      }]
      for (const rung of [...ladder.frontier, ...ladder.unmetered]) {
        models.push({
          provider: PROVIDER_ID,
          id: rung.id,
          name: rung.label,
          inputModalities: rung.acceptsImage === true ? ['text', 'image'] : ['text'],
          badge: {
            text: modelBadge(rung),
            tone: rung.tier === 'unmetered' ? 'success' : 'neutral',
          },
        })
      }
      return models
    },

    /**
     * Describe one exact model route.
     * @param {string} _provider - the route.
     * @param {string} modelId - the model id.
     * @returns {Promise<object>} resolved metadata.
     */
    async resolveModel(_provider, modelId) {
      const ladder = refreshLadder()
      if (modelId === autoId) {
        // Auto may route to any rung, so it advertises the NARROWEST window on the
        // ladder: a conversation the harness lets grow past the smallest model's
        // limit would be accepted here and then refused upstream. The floor keeps
        // one small model from forcing constant compaction on everything else.
        const windows = [...ladder.frontier, ...ladder.unmetered]
          .map(rung => rung.contextWindow ?? 0)
          .filter(window => window > 0)
        const narrowest = windows.length > 0 ? Math.min(...windows) : 131_072
        const contextWindow = Math.max(narrowest, 32_768)
        return {
          provider: PROVIDER_ID,
          id: autoId,
          name: config.autoModelName,
          context: { contextWindow },
          defaultMaxTokens: Math.min(32_768, contextWindow),
          inputModalities: ['text'],
        }
      }
      const rung = rungOf(modelId)
      if (rung === undefined) {
        return { provider: PROVIDER_ID, id: modelId, name: modelId, context: { contextWindow: 131_072 }, defaultMaxTokens: 32_768, inputModalities: ['text'] }
      }
      return {
        provider: PROVIDER_ID,
        id: rung.id,
        name: rung.label,
        context: { contextWindow: rung.contextWindow },
        defaultMaxTokens: rung.maxTokens,
        inputModalities: rung.acceptsImage === true ? ['text', 'image'] : ['text'],
      }
    },

    /**
     * Bind resolution and dispatch to one generation.
     * @param {string} provider - the route.
     * @param {string} modelId - the model id.
     * @param {AbortSignal} [signal] - cancellation.
     * @returns {Promise<{model: object, stream: (options: object) => AsyncIterable<object>}>} the prepared call.
     */
    async prepareCall(provider, modelId, signal) {
      const model = await adapter.resolveModel(provider, modelId, signal)
      return { model, stream: options => adapter.stream(options) }
    },

    /**
     * Stream one model call.
     * @param {object} options - the harness generate options.
     * @returns {AsyncGenerator<object>} harness chunks.
     */
    async *stream(options) {
      refreshLadder()
      if (options.model === autoId) {
        yield* runChain(options, router.plan(), config.autoModelName)
        return
      }
      const rung = rungOf(options.model)
      if (rung === undefined) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: `DeepAI Code has no model "${options.model}"; refresh the catalog from the plugin settings`, code: 'NO_MODEL' },
          },
        }
        return
      }
      yield* streamExplicit(options, rung)
    },

    /**
     * Rebuild the tiers from the current catalog and return the ladder.
     *
     * The daily free-model check calls this after re-reading the catalog, so the
     * router, the model picker and the settings page never disagree.
     *
     * @returns {object} the ladder just installed.
     */
    syncCatalog() {
      return refreshLadder()
    },

    /**
     * Read the routing state for the plugin's status surface.
     * @returns {object} a detached snapshot.
     */
    status() {
      return {
        ...router.snapshot(),
        catalogLive: catalog.live,
        catalogAgeMs: catalog.fetchedAt === 0 ? null : Date.now() - catalog.fetchedAt,
        lane: client.lane,
        signedIn: client.hasKey,
      }
    },
  }

  return adapter
}
