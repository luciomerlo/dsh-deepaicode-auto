/**
 * Release check for the bundle: manifest completeness, locale resources, icon
 * bounds, a real import of every runtime module, the market index, and a
 * hygiene scan that keeps local paths and credentials out of the repository.
 *
 * A linked local bundle is not packaged, so this script stands in for the
 * pack-time checks a published package would get.
 *
 * @module dsh-deepaicode-auto/scripts/check
 */

import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []
const checked = []

/**
 * Record one check result.
 * @param {string} label - what was checked.
 * @param {() => void | Promise<void>} run - the assertion body.
 * @returns {Promise<void>} resolves when the check has run.
 */
async function check(label, run) {
  try {
    await run()
    checked.push(label)
  } catch (error) {
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Runtime and documentation files that ship in the repository. */
async function repositoryFiles() {
  const files = ['index.js', 'client.js', 'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'index.json', 'icon.svg']
  for (const directory of ['src', 'test', 'scripts', 'locale']) {
    for (const name of await readdir(join(root, directory))) files.push(`${directory}/${name}`)
  }
  return files
}

await check('package.json manifest', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(typeof manifest.name, 'string')
  assert.equal(typeof manifest.version, 'string')
  assert.equal(manifest.type, 'module')
  assert.equal(typeof manifest.exports['.'], 'string')
  assert.equal(manifest.exports['./icon'], './icon.svg')
  assert.equal(manifest.exports['./client'], './client.js')
  assert.ok('./locale/*.json' in manifest.exports)
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.ok(manifest.files.includes('client.js') && manifest.files.includes('index.js'))
  assert.equal(manifest.license, 'MIT')
})

await check('cordis.patch.yml', async () => {
  const text = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(text, /^- insert:/m, 'the patch must contain an insert list')
  assert.match(text, /name: dsh-deepaicode-auto/, 'the inserted row must name this package')
  assert.match(text, /autoModelId: auto/, 'the Auto model id must be configured')
  assert.match(text, /streamIdleTimeoutMs:/, 'the stream watchdog must be configured')
})

await check('locale resources', async () => {
  const directory = join(root, 'locale')
  const files = (await readdir(directory)).filter(file => file.endsWith('.json'))
  assert.ok(files.includes('en.json'), 'the English metadata must ship')
  for (const file of files) {
    const parsed = JSON.parse(await readFile(join(directory, file), 'utf8'))
    assert.equal(typeof parsed.meta?.title, 'string', `${file} needs meta.title`)
    assert.ok(parsed.meta.description.length > 80, `${file} needs a real meta.description`)
  }
})

await check('icon.svg', async () => {
  const path = join(root, 'icon.svg')
  const info = await stat(path)
  assert.ok(info.size < 256 * 1024, 'the icon must stay under 256 KiB')
  const svg = await readFile(path, 'utf8')
  assert.match(svg, /viewBox="0 0 36 36"/)
  assert.doesNotMatch(svg, /<script|<style|<image|<foreignObject/, 'the icon must be self-contained geometry')
})

await check('release files', async () => {
  for (const name of ['LICENSE', 'README.md', 'index.json', '.gitignore', '.env.example']) {
    const info = await stat(join(root, name))
    assert.ok(info.size > 0, `${name} must not be empty`)
  }
  const licence = await readFile(join(root, 'LICENSE'), 'utf8')
  assert.match(licence, /MIT License/)
  assert.match(licence, /Copyright \(c\) 2026 /, 'the licence must carry the release year')
})

await check('plugin market index', async () => {
  const index = JSON.parse(await readFile(join(root, 'index.json'), 'utf8'))
  assert.equal(index.format, 1)
  assert.ok(Array.isArray(index.plugins) && index.plugins.length > 0)
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const plugin = index.plugins.find(entry => entry.name === manifest.name)
  assert.ok(plugin, 'the index must list this package')
  assert.ok(Array.isArray(plugin.versions) && plugin.versions.length > 0)
  const [version] = plugin.versions
  assert.match(version.version, /^\d+\.\d+\.\d+$/)
  assert.ok(Number.isInteger(version.publishTimestamp))
  assert.equal(version.source.type, 'git')
  assert.match(version.source.url, /^https:\/\/github\.com\/[^/]+\/[^/]+$/)
  assert.match(version.source.commit, /^[0-9a-f]{40}$/, 'a git source must pin a lowercase 40-hex commit')
})

await check('runtime modules import', async () => {
  const modules = [
    'index.js',
    'src/adapter.js',
    'src/auth.js',
    'src/body.js',
    'src/catalog.js',
    'src/client.js',
    'src/connection.js',
    'src/identity.js',
    'src/models.js',
    'src/router.js',
    'src/routes.js',
    'src/sse.js',
    'src/stream.js',
    'src/tools.js',
    'src/verify.js',
  ]
  for (const relative of modules) {
    await import(new URL(`../${relative}`, import.meta.url).href)
  }
  const entry = await import(new URL('../index.js', import.meta.url).href)
  assert.equal(typeof entry.apply, 'function', 'index.js must export apply()')
  assert.deepEqual(entry.inject, ['llm'], 'the plugin injects the llm service')
})

await check('client half', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const source = await readFile(join(root, 'client.js'), 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load\(/, 'the browser artifact must register itself')
  assert.ok(
    source.includes(`id: '${manifest.name}'`),
    'the module-loader id must equal the package name',
  )
  assert.match(source, /ctx\.slots\.register\(\{[\s\S]*?name: 'settings\.section'/, 'the page registers into settings.section')
  assert.match(source, /ctx\.locale\.register\(/, 'visible text goes through the client locale service')
  assert.doesNotMatch(source, /\brequire\('@deepseek-ai\//, 'no harness client package may be imported')

  // The browser half and the Host half must agree on every route spelling, or
  // the settings page would call an address nothing answers.
  const { DEEPAICODE_BROWSER_ROUTES } = await import(new URL('../src/routes.js', import.meta.url).href)
  for (const [key, path] of Object.entries(DEEPAICODE_BROWSER_ROUTES)) {
    assert.ok(source.includes(`${key}: '${path}'`), `client.js must call the "${key}" route as ${path}`)
  }
})

await check('no harness runtime imports', async () => {
  const files = ['index.js', ...(await readdir(join(root, 'src'))).map(file => `src/${file}`)]
  for (const relative of files) {
    const text = await readFile(join(root, relative), 'utf8')
    const offenders = [...text.matchAll(/^\s*import\s[^'"]*['"](@deepseek-ai\/[^'"]+)['"]/gm)]
    assert.equal(offenders.length, 0, `${relative} imports ${offenders.map(match => match[1]).join(', ')}`)
  }
})

await check('no credentials or local paths', async () => {
  // Patterns that must never reach a public repository: a home directory path,
  // a checkout path, a GitHub token, or a DeepAI account key. The UUID rule
  // covers shipped code only: test fixtures use obviously fake, fixed UUIDs on
  // purpose, and those files are never loaded by the running plugin.
  const forbidden = [
    { pattern: /[A-Za-z]:[\\/]Users[\\/]/i, label: 'a local user directory path' },
    { pattern: /[A-Za-z]:[\\/]Proyectos/i, label: 'a local checkout path' },
    { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/, label: 'a GitHub token' },
  ]
  const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i
  for (const relative of await repositoryFiles()) {
    const text = await readFile(join(root, relative), 'utf8')
    for (const { pattern, label } of forbidden) {
      assert.doesNotMatch(text, pattern, `${relative} contains ${label}`)
    }
    if (!relative.startsWith('test/')) {
      assert.doesNotMatch(text, uuidPattern, `${relative} contains a UUID literal (DeepAI keys are UUIDs)`)
    }
  }
})

if (failures.length > 0) {
  console.error('check failed:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(`check passed: ${String(checked.length)} groups`)
for (const label of checked) console.log(`  ok  ${label}`)
