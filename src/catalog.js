/**
 * The model catalog: the live DeepAI Code `/models` snapshot plus the official
 * fallback table.
 *
 * The upstream catalog is authoritative — a model DeepAI adds appears in the
 * selector without a plugin release — but the endpoints require an `Api-Key`,
 * so a first run without credentials still needs the published table to show
 * anything at all.
 *
 * @module dsh-deepaicode-auto/catalog
 */

/** How long a live catalog stays fresh before a background refresh. */
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000

/** Default capacity used when an entry advertises none. */
export const DEFAULT_CONTEXT_WINDOW = 131_072

/** Default output cap used when an entry advertises none. */
export const DEFAULT_MAX_TOKENS = 32_768

/**
 * The published DeepAI Code catalog as of 2026-11-19: 27 models from 13 labs,
 * 16 Frontier models paid in Theos and 11 unmetered. Costs are the values the
 * product page shows next to each model name.
 * @type {ReadonlyArray<{id: string, name: string, theos: number, api?: string, contextWindow: number, maxTokens: number}>}
 */
export const FALLBACK_MODELS = Object.freeze([
  // ── Frontier: spends the daily Theos allowance ──
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', theos: 50, api: 'openai-responses', contextWindow: 400_000, maxTokens: 128_000 },
  { id: 'claude-fable-5-2', name: 'Claude Fable 5.2', theos: 20, contextWindow: 400_000, maxTokens: 128_000 },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', theos: 15, contextWindow: 400_000, maxTokens: 128_000 },
  { id: 'muse-wonder', name: 'Muse Wonder', theos: 15, contextWindow: 1_048_576, maxTokens: 131_072 },
  { id: 'qwen-3.8-max-prime', name: 'Qwen 3.8 Max Prime', theos: 15, contextWindow: 1_000_000, maxTokens: 131_072 },
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', theos: 10, contextWindow: 400_000, maxTokens: 128_000 },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', theos: 10, contextWindow: 400_000, maxTokens: 128_000 },
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon', theos: 10, contextWindow: 1_048_576, maxTokens: 131_072 },
  { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', theos: 10, contextWindow: 1_048_576, maxTokens: 131_072 },
  { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', theos: 8, contextWindow: 1_048_576, maxTokens: 131_072 },
  { id: 'muse-spark-1.3', name: 'Muse Spark 1.3', theos: 6, contextWindow: 1_048_576, maxTokens: 131_072 },
  { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', theos: 5, contextWindow: 400_000, maxTokens: 128_000 },
  { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', theos: 3, contextWindow: 1_048_576, maxTokens: 131_072 },
  { id: 'kimi-k3', name: 'Kimi K3', theos: 3, contextWindow: 1_048_576, maxTokens: 131_072 },
  { id: 'glm-5.3', name: 'GLM 5.3', theos: 3, contextWindow: 202_752, maxTokens: 131_072 },
  { id: 'minimax-m3', name: 'MiniMax M3', theos: 2, contextWindow: 1_048_576, maxTokens: 131_072 },
  // ── Unmetered: 0 Theos per request ──
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash 1017', theos: 0, contextWindow: 1_048_576, maxTokens: 131_072 },
  { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', theos: 0, contextWindow: 1_048_576, maxTokens: 131_072 },
  { id: 'qwen-3.8-flash', name: 'Qwen 3.8 Flash', theos: 0, contextWindow: 1_000_000, maxTokens: 131_072 },
  { id: 'mimo-2.6-pro', name: 'MiMo 2.6 Pro', theos: 0, contextWindow: 1_048_576, maxTokens: 131_072 },
  { id: 'mimo-2.6-flash', name: 'MiMo 2.6 Flash', theos: 0, contextWindow: 1_048_576, maxTokens: 131_072 },
  { id: 'minimax-m3.1-flash', name: 'MiniMax M3.1 Flash', theos: 0, contextWindow: 1_048_576, maxTokens: 131_072 },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', theos: 0, contextWindow: 1_048_576, maxTokens: 128_000 },
  { id: 'muse-ember', name: 'Muse Ember', theos: 0, contextWindow: 1_048_576, maxTokens: 131_072 },
  { id: 'solar-mini-4', name: 'Solar Mini 4', theos: 0, contextWindow: 131_072, maxTokens: 32_768 },
  { id: 'glyph-cluster', name: 'Glyph Cluster', theos: 0, contextWindow: 131_072, maxTokens: 32_768 },
  { id: 'deepai-cyber', name: 'DeepAI Cyber', theos: 0, contextWindow: 131_072, maxTokens: 32_768 },
])

/**
 * Normalize one raw upstream model entry into adapter metadata.
 * @param {Record<string, unknown>} raw - one object from `GET /models`.
 * @returns {import('./models.js').NormalizedCatalogEntry | undefined} the entry, or undefined when it names no id.
 */
export function normalizeUpstreamModel(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const id = typeof raw.id === 'string' && raw.id.trim() !== ''
    ? raw.id.trim()
    : typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : undefined
  if (id === undefined) return undefined
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : id
  const contextWindow = positive(raw.contextWindow, DEFAULT_CONTEXT_WINDOW)
  const maxTokens = positive(raw.maxTokens, DEFAULT_MAX_TOKENS)
  return {
    id,
    label: name,
    cost: costOf(raw),
    api: raw.api === 'openai-responses' ? 'openai-responses' : 'openai-completions',
    contextWindow,
    maxTokens,
    reasoning: raw.reasoning === true,
    acceptsImage: Array.isArray(raw.input) && raw.input.includes('image'),
  }
}

/**
 * Read the per-request Theos cost out of an upstream entry.
 * Upstream sends `theosPerRequest` as a decimal string (`"0"`, `"15.00000"`).
 * @param {Record<string, unknown>} raw - one object from `GET /models`.
 * @returns {number | undefined} the cost, or undefined when absent.
 */
export function costOf(raw) {
  for (const key of ['theosPerRequest', 'theos', 'cost']) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number.parseFloat(value)
      if (Number.isFinite(parsed) && parsed >= 0) return parsed
    }
  }
  if (raw.premier === false) return 0
  return undefined
}

/**
 * Coerce a numeric candidate into a positive integer.
 * @param {unknown} value - raw candidate.
 * @param {number} fallback - value used when the candidate is unusable.
 * @returns {number} the positive integer.
 */
function positive(value, fallback) {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/**
 * Seed a normalized map from the published fallback table.
 * @returns {Map<string, object>} normalized entries keyed by model id.
 */
export function fallbackCatalog() {
  const map = new Map()
  for (const model of FALLBACK_MODELS) {
    map.set(model.id, {
      id: model.id,
      label: model.name,
      cost: model.theos,
      api: model.api ?? 'openai-completions',
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: true,
      acceptsImage: true,
    })
  }
  return map
}

/**
 * Catalog cache with a live snapshot over a fallback table.
 *
 * The list is refreshed at plugin start, on a long TTL, and — as the routing
 * contract requires — every time a model fails.
 */
export class ModelCatalog {
  /** @type {Map<string, object>} */
  #models = fallbackCatalog()
  #fetchedAt = 0
  #inflight = /** @type {Promise<boolean> | undefined} */ (undefined)
  /** @type {(signal?: AbortSignal) => Promise<Array<Record<string, unknown>>>} */
  #fetchModels
  /** @type {{warn: (...args: unknown[]) => void} | undefined} */
  #logger
  #failures = 0

  /**
   * @param {object} options - catalog wiring.
   * @param {(signal?: AbortSignal) => Promise<Array<Record<string, unknown>>>} options.fetchModels - performs the upstream GET.
   * @param {{warn: (...args: unknown[]) => void}} [options.logger] - sink for refresh failures.
   */
  constructor(options) {
    this.#fetchModels = options.fetchModels
    this.#logger = options.logger
  }

  /** @returns {Map<string, object>} the current normalized catalog. */
  list() {
    return this.#models
  }

  /** @returns {object[]} the current catalog as an array. */
  models() {
    return [...this.#models.values()]
  }

  /** @returns {boolean} whether the current list came from a live upstream read. */
  get live() {
    return this.#fetchedAt > 0
  }

  /** @returns {number} epoch milliseconds of the last successful refresh, 0 when never. */
  get fetchedAt() {
    return this.#fetchedAt
  }

  /** @returns {number} consecutive refresh failures since the last success. */
  get failures() {
    return this.#failures
  }

  /**
   * Fetch the catalog once per call, sharing an in-flight request.
   * @param {object} [options] - refresh options.
   * @param {boolean} [options.force] - ignore the TTL.
   * @param {AbortSignal} [options.signal] - cancellation.
   * @returns {Promise<boolean>} whether the refresh replaced the list.
   */
  async refresh(options = {}) {
    const fresh = this.#fetchedAt > 0 && Date.now() - this.#fetchedAt < CATALOG_TTL_MS
    if (!options.force && fresh) return false
    if (this.#inflight !== undefined) return this.#inflight

    this.#inflight = (async () => {
      try {
        const raw = await this.#fetchModels(options.signal)
        const next = new Map()
        for (const item of raw) {
          const normalized = normalizeUpstreamModel(item)
          if (normalized !== undefined) next.set(normalized.id, normalized)
        }
        if (next.size === 0) throw new Error('the catalog endpoint returned no usable entries')
        this.#models = next
        this.#fetchedAt = Date.now()
        this.#failures = 0
        return true
      } catch (error) {
        this.#failures += 1
        this.#logger?.warn('deepaicode: model catalog refresh failed', error)
        return false
      } finally {
        this.#inflight = undefined
      }
    })()
    return this.#inflight
  }
}
