/**
 * Model tiers and the ladder the Auto router walks.
 *
 * Two sources feed the ladder:
 *  - the plugin Config (`frontier` / `unmetered`), which is the authoritative
 *    hand-written table and survives an unreachable catalog;
 *  - the live DeepAI Code catalog (`GET /deepai_code/models`), whose per-model
 *    cost, when the endpoint exposes one, overrides the configured cost.
 *
 * Nothing here performs I/O, so the whole module is unit-testable.
 *
 * @module dsh-deepaicode-auto/models
 */

/** Selector id of the virtual routing model. */
export const AUTO_MODEL_ID = 'auto'

/**
 * Fallback Frontier table, ordered by reasoning capability. Used only when the
 * Config omits a `frontier` list.
 * @type {ReadonlyArray<{id: string, theos: number, label: string}>}
 */
export const DEFAULT_FRONTIER = Object.freeze([
  { id: 'gpt-6-astra', theos: 50, label: 'GPT-6 Astra' },
  { id: 'claude-fable-5-2', theos: 20, label: 'Claude Fable 5.2' },
  { id: 'claude-opus-5-5', theos: 15, label: 'Claude Opus 5.5' },
  { id: 'muse-wonder', theos: 15, label: 'Muse Wonder' },
  { id: 'qwen-3.8-max-prime', theos: 15, label: 'Qwen 3.8 Max Prime' },
  { id: 'gpt-6.1-sol', theos: 10, label: 'GPT-6.1 Sol' },
  { id: 'claude-sonnet-5-5', theos: 10, label: 'Claude Sonnet 5.5' },
  { id: 'gemini-4-argon', theos: 10, label: 'Gemini 4 Argon' },
  { id: 'gemini-4-carbon', theos: 10, label: 'Gemini 4 Carbon' },
  { id: 'gemini-4-hydrogen', theos: 8, label: 'Gemini 4 Hydrogen' },
  { id: 'muse-spark-1.3', theos: 6, label: 'Muse Spark 1.3' },
  { id: 'gpt-6.1-terra', theos: 5, label: 'GPT-6.1 Terra' },
  { id: 'kimi-k3.1-pro', theos: 3, label: 'Kimi K3.1 Pro' },
  { id: 'kimi-k3', theos: 3, label: 'Kimi K3' },
  { id: 'glm-5.3', theos: 3, label: 'GLM 5.3' },
  { id: 'minimax-m3', theos: 2, label: 'MiniMax M3' },
])

/**
 * Fallback Unmetered table (0 Theos per request), priority order.
 * @type {ReadonlyArray<string>}
 */
export const DEFAULT_UNMETERED = Object.freeze([
  'deepseek-v4.1-flash',
  'glm-5.3-flash',
  'qwen-3.8-flash',
  'mimo-2.6-pro',
  'mimo-2.6-flash',
  'minimax-m3.1-flash',
  'gpt-6-luna',
  'muse-ember',
  'solar-mini-4',
  'glyph-cluster',
  'deepai-cyber',
])

/** Cost in Theos that marks a catalog model as unmetered. */
export const UNMETERED_COST = 0

const COST_KEYS = ['theosPerRequest', 'theos', 'theosCost', 'costTheos', 'credits', 'price', 'cost', 'unitCost']

/**
 * Read a per-request Theos cost from one catalog entry.
 * @param {Record<string, unknown>} entry - one raw model object from the catalog endpoint.
 * @returns {number | undefined} a finite non-negative cost, or undefined when the entry exposes none.
 */
export function catalogCost(entry) {
  if (!entry || typeof entry !== 'object') return undefined
  if (entry.unmetered === true || entry.isUnmetered === true) return UNMETERED_COST
  if (entry.free === true) return UNMETERED_COST
  for (const key of COST_KEYS) {
    const value = entry[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      if (Number.isFinite(parsed) && parsed >= 0) return parsed
    }
    if (value && typeof value === 'object') {
      for (const nested of COST_KEYS) {
        const inner = value[nested]
        if (typeof inner === 'number' && Number.isFinite(inner) && inner >= 0) return inner
      }
    }
  }
  return undefined
}

/**
 * Pick the endpoint family a catalog entry requires.
 * @param {Record<string, unknown>} entry - one raw model object from the catalog endpoint.
 * @returns {'openai-responses' | 'openai-completions'} the wire family to use.
 */
export function catalogApi(entry) {
  const api = entry && (entry.api ?? entry.protocol ?? entry.endpoint ?? entry.wire)
  if (typeof api === 'string' && api.trim().toLowerCase() === 'openai-responses') return 'openai-responses'
  return 'openai-completions'
}

/**
 * Normalize a raw catalog entry into the metadata the adapter and router share.
 * @param {Record<string, unknown>} entry - one raw model object.
 * @returns {{id: string, label: string, cost: number | undefined, api: string, contextWindow: number, maxTokens: number} | undefined}
 */
export function normalizeCatalogEntry(entry) {
  if (!entry || typeof entry !== 'object') return undefined
  const id = typeof entry.id === 'string' && entry.id.length > 0
    ? entry.id
    : typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : undefined
  if (id === undefined) return undefined
  const label = typeof entry.label === 'string' && entry.label.length > 0
    ? entry.label
    : typeof entry.displayName === 'string' && entry.displayName.length > 0
      ? entry.displayName
      : typeof entry.title === 'string' && entry.title.length > 0 ? entry.title : id
  const contextWindow = positive(entry.contextWindow ?? entry.context_window ?? entry.context ?? 128000)
  const maxTokens = positive(entry.maxTokens ?? entry.max_tokens ?? entry.maxOutputTokens ?? 8192)
  return { id, label, cost: catalogCost(entry), api: catalogApi(entry), contextWindow, maxTokens }
}

/**
 * Coerce a candidate number into a positive integer, keeping a default otherwise.
 * @param {unknown} value - raw candidate.
 * @param {number} [fallback] - value used when the candidate is unusable.
 * @returns {number} the positive integer.
 */
export function positive(value, fallback = 131072) {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/**
 * Build the ordered ladder the router walks.
 *
 * A model named in both tables is treated as Frontier, because an explicit
 * cost in the catalog wins over the configured tier.
 *
 * @param {{frontier?: ReadonlyArray<{id: string, theos?: number, label?: string}>, unmetered?: ReadonlyArray<string>}} config - plugin Config tier tables.
 * @param {ReadonlyMap<string, {id: string, label: string, cost: number | undefined, api: string, contextWindow: number, maxTokens: number}>} [catalog] - normalized live catalog, keyed by model id.
 * @returns {{frontier: Array<object>, unmetered: Array<object>}} the two ordered rungs.
 */
export function buildLadder(config, catalog = new Map()) {
  const configuredFrontier = Array.isArray(config.frontier) && config.frontier.length > 0
    ? config.frontier
    : DEFAULT_FRONTIER
  const configuredUnmetered = Array.isArray(config.unmetered) && config.unmetered.length > 0
    ? config.unmetered
    : DEFAULT_UNMETERED

  const frontier = []
  const seen = new Set()
  for (const row of configuredFrontier) {
    const id = typeof row === 'string' ? row : row?.id
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const live = catalog.get(id)
    const declared = typeof row === 'object' && row !== null ? row.theos : undefined
    const theos = live?.cost !== undefined
      ? live.cost
      : typeof declared === 'number' && Number.isFinite(declared) && declared >= 0 ? declared : 10
    frontier.push({
      id,
      tier: 'frontier',
      label: (typeof row === 'object' && row?.label) || live?.label || id,
      theos,
      api: live?.api ?? 'openai-completions',
      contextWindow: live?.contextWindow ?? 131072,
      maxTokens: live?.maxTokens ?? 32768,
      inCatalog: live !== undefined,
    })
  }

  const unmetered = []
  for (const row of configuredUnmetered) {
    const id = typeof row === 'string' ? row : row?.id
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const live = catalog.get(id)
    unmetered.push({
      id,
      tier: 'unmetered',
      label: live?.label || id,
      theos: UNMETERED_COST,
      api: live?.api ?? 'openai-completions',
      contextWindow: live?.contextWindow ?? 131072,
      maxTokens: live?.maxTokens ?? 32768,
      inCatalog: live !== undefined,
    })
  }

  // A catalog model that is neither configured nor unmetered is still a real
  // model: DeepAI adds them without warning, so the catalog tail keeps the
  // router complete. Models the catalog prices at 0 join the free tail; priced
  // models are appended after the configured Frontier order, most capable first.
  const discovered = []
  for (const model of catalog.values()) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    const rung = {
      id: model.id,
      tier: model.cost === UNMETERED_COST ? 'unmetered' : 'frontier',
      label: model.label,
      theos: model.cost === UNMETERED_COST ? UNMETERED_COST : model.cost,
      api: model.api,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      inCatalog: true,
      discovered: true,
    }
    if (rung.tier === 'unmetered') unmetered.push(rung)
    else if (typeof rung.theos === 'number') discovered.push(rung)
  }
  discovered.sort((a, b) => b.theos - a.theos || a.id.localeCompare(b.id))
  frontier.push(...discovered)

  return { frontier, unmetered }
}

/**
 * Describe a model id for the selector, tagging its price or its zero cost.
 * @param {object} model - one ladder rung.
 * @returns {string} the selector label.
 */
export function modelBadge(model) {
  return model.tier === 'unmetered' || model.theos === 0
    ? 'Unmetered · 0 Theos'
    : `${model.theos} Theos`
}

