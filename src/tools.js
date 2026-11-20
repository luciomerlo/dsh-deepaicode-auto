/**
 * Model-facing surface for the free-model verification.
 *
 * The same operation backs the Settings page and this tool: one controller
 * method produces the report, and both callers present it. The tool is the
 * programmatic (`api`) path — an agent or an automation can read the tier or
 * re-verify it without opening the GUI.
 *
 * @module dsh-deepaicode-auto/tools
 */

/** Tool name exposed to the model. */
export const FREE_MODELS_TOOL = 'deepaicode_free_models'

/**
 * Render one epoch-millisecond instant as ISO text.
 * @param {number | null | undefined} value - the instant.
 * @returns {string | null} the ISO string, or null.
 */
function iso(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return new Date(value).toISOString()
}

/**
 * Project a verification report onto the bounded shape the model receives.
 *
 * Absent instants are omitted rather than sent as null: the declared output
 * schema types those fields as strings, and the tool layer validates what a
 * definition returns against its own schema.
 *
 * @param {object} report - the verifier's report.
 * @returns {Record<string, unknown>} a JSON-serializable summary.
 */
export function summarizeVerification(report) {
  const summary = {
    verified: report.verified === true,
    source: report.catalogLive ? 'live catalog' : 'published table',
    checkedEveryHours: Math.max(1, Math.round((report.intervalMs ?? 0) / 3_600_000)),
    catalogCount: report.catalogCount ?? 0,
    freeCount: report.freeIds.length,
    freeModels: [...report.freeIds],
    newlyFree: [...report.added],
    noLongerFree: report.reclassified.map(entry => ({ id: entry.id, theos: entry.theos })),
    removedFromCatalog: [...report.removed],
    missingFromCatalog: [...report.skipped],
  }
  const checkedAt = iso(report.checkedAt)
  if (checkedAt !== null) summary.checkedAt = checkedAt
  const nextCheckAt = iso(report.nextCheckAt)
  if (nextCheckAt !== null) summary.nextCheckAt = nextCheckAt
  return summary
}

/**
 * Build the `deepaicode_free_models` tool definition.
 * @param {object} parts - collaborators.
 * @param {{report: () => object, verify: (options?: object) => Promise<object>}} parts.verifier - the free-model verifier.
 * @returns {object} the tool definition the `tools` service registers.
 */
export function createFreeModelsTool(parts) {
  const { verifier } = parts
  return {
    name: FREE_MODELS_TOOL,
    description:
      'Report which DeepAI Code models cost 0 Theos right now, when that was last verified, and what changed '
      + 'at the last check. The tier is verified against the upstream catalog once a day and again whenever a '
      + 'model fails. Pass verify: true to re-read the catalog immediately and rebuild the tiers.',
    parameters: {
      type: 'object',
      properties: {
        verify: {
          type: 'boolean',
          description: 'Re-read the DeepAI Code catalog now instead of reporting the last daily check.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          verified: { type: 'boolean' },
          source: { type: 'string' },
          checkedAt: { type: 'string' },
          nextCheckAt: { type: 'string' },
          checkedEveryHours: { type: 'number' },
          catalogCount: { type: 'number' },
          freeCount: { type: 'number' },
          freeModels: { type: 'array', items: { type: 'string' } },
          newlyFree: { type: 'array', items: { type: 'string' } },
          noLongerFree: {
            type: 'array',
            items: { type: 'object', properties: { id: { type: 'string' }, theos: { type: 'number' } } },
          },
          removedFromCatalog: { type: 'array', items: { type: 'string' } },
          missingFromCatalog: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    /**
     * @param {unknown} args - the call arguments.
     * @returns {Promise<Record<string, unknown>>} the bounded report.
     */
    async execute(args) {
      const wantsVerify = args !== null && typeof args === 'object' && args.verify === true
      const report = wantsVerify ? await verifier.verify({ force: true }) : verifier.report()
      return summarizeVerification(report)
    },
  }
}

/**
 * Register the tool when the profile has a tool registry.
 * @param {any} ctx - the plugin context.
 * @param {object} definition - the tool definition.
 * @param {{info: Function, warn: Function}} logger - diagnostics sink.
 * @returns {boolean} whether the tool was registered.
 */
export function registerFreeModelsTool(ctx, definition, logger) {
  const tools = ctx.get('tools')
  if (tools === undefined || typeof tools.register !== 'function') {
    logger.warn('deepaicode: no tool registry is mounted, so the free-model tool stays off')
    return false
  }
  ctx.effect(() => tools.register(definition), 'deepaicode: free-model tool')
  return true
}
