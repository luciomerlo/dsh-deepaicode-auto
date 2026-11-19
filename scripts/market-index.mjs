/**
 * Generate `index.json`, the format-1 plugin market index for this repository.
 *
 * A Git-backed market version must pin an exact commit, which cannot be the
 * commit that introduces the file. The index is therefore generated *after* the
 * release commit exists: pass that commit explicitly, or let the script use the
 * current `HEAD`.
 *
 * Usage:
 *   node scripts/market-index.mjs [commit]
 *
 * @module dsh-deepaicode-auto/scripts/market-index
 */

import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

const repositoryUrl = 'https://github.com/luciomerlo/dsh-deepaicode-auto'

/**
 * Resolve a commit reference to a full lowercase SHA.
 * @param {string} reference - a ref name or SHA.
 * @returns {string} the 40-hex commit id.
 */
function resolveCommit(reference) {
  const sha = execFileSync('git', ['rev-parse', reference], { cwd: root, encoding: 'utf8' }).trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`git rev-parse ${reference} did not return a commit id`)
  return sha
}

const commit = resolveCommit(process.argv[2] ?? 'HEAD')
const publishTimestamp = Math.floor(Date.now() / 1000)

const index = {
  format: 1,
  title: 'DeepAI Code router for DeepSeek Harness',
  description:
    'DeepSeek Harness model providers that add their own routing layer: capability-ordered '
    + 'model ladders with automatic, per-turn failover.',
  metadata: {
    categories: {
      models: { title: 'Model providers' },
    },
    labels: {
      routing: { title: 'Routing' },
      failover: { title: 'Failover' },
    },
    sortKeys: {},
  },
  plugins: [
    {
      name: manifest.name,
      title: 'DeepAI Code router',
      description:
        'Registers the DeepAI Code model catalog as the "DeepAI Code" provider and adds the virtual '
        + '"Auto (DeepAiCode)" model: Frontier models first, unmetered models when the daily credit '
        + 'allowance is spent, hot failover on every upstream failure, and an SSE idle watchdog so a '
        + 'stalled stream never drops a turn.',
      icon: `${repositoryUrl}/raw/main/${manifest.exports['./icon'].replace('./', '')}`,
      author: manifest.author,
      homepage: `${repositoryUrl}#readme`,
      repository: { url: repositoryUrl },
      metadata: {
        category: 'models',
        keywords: manifest.keywords,
        labels: ['routing', 'failover'],
        sortKeys: {},
      },
      versions: [
        {
          version: manifest.version,
          publishTimestamp,
          source: { type: 'git', url: repositoryUrl, commit },
          engines: {},
        },
      ],
    },
  ],
}

await writeFile(join(root, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
console.log(`index.json written: ${manifest.name}@${manifest.version} pinned to ${commit}`)
