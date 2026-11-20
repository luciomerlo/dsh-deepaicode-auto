import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = await readFile(join(root, 'client.js'), 'utf8')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

/** A React stand-in exposing only the API the browser half touches. */
function reactStub() {
  const createElement = (type, props, ...children) => ({ type, props, children })
  return {
    createElement,
    createContext: value => ({ __context: true, value }),
    Fragment: 'Fragment',
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: fn => fn,
    useContext: context => context.value,
    useSyncExternalStore: () => undefined,
  }
}

/**
 * Load the browser artifact in a sandbox and capture what it registers.
 * @returns {{spec: any, mod: any}} the registered module spec and its factory result.
 */
function loadClient() {
  let spec
  const window = { __ModuleLoader__: { load: value => { spec = value } } }
  const require = id => {
    if (id === 'react') return reactStub()
    throw new Error(`unexpected module import: ${id}`)
  }
  vm.runInNewContext(source, { window, console, fetch: () => Promise.reject(new Error('no network')), setTimeout, clearTimeout })
  assert.ok(spec, 'the artifact registers itself with the module loader')
  return { spec, mod: spec.factory(require) }
}

test('the browser artifact registers under the package name', () => {
  const { spec } = loadClient()
  assert.equal(spec.id, manifest.name)
  assert.equal(typeof spec.factory, 'function')
})

test('the factory returns a plugin that injects slots and locale', () => {
  const { mod } = loadClient()
  // Spread first: the sandbox has its own Array prototype, which deepEqual rejects.
  assert.deepEqual([...mod.inject], ['slots', 'locale'])
  assert.equal(typeof mod.apply, 'function')
})

test('apply registers one English dictionary and one settings section', () => {
  const { mod } = loadClient()
  const dictionaries = []
  const registrations = []
  const injected = []
  const ctx = {
    locale: {
      register: (ns, locale, dict) => { dictionaries.push({ ns, locale, dict }) },
      bind: () => key => key,
      subscribe: () => () => {},
      getSnapshot: () => ({ active: 'en', locales: [], revision: 1 }),
    },
    slots: {
      inject: (slot, callback) => { injected.push(slot); callback() },
      register: (options, Component) => { registrations.push({ options, Component }) },
    },
  }

  mod.apply(ctx)

  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].ns, 'deepaicode')
  assert.equal(dictionaries[0].locale, 'en')
  assert.ok(Object.keys(dictionaries[0].dict).length > 20, 'the page ships a real dictionary')

  assert.deepEqual(injected, ['settings.section'])
  assert.equal(registrations.length, 1)
  const { options, Component } = registrations[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'deepaicode')
  assert.equal(typeof options.order, 'number')
  assert.equal(typeof options.label, 'function', 'the nav label is a thunk so it follows the locale')
  assert.equal(options.label(), 'section.title', 'the thunk resolves through the bound translator')
  assert.equal(typeof Component, 'function')
})

test('every dictionary key the page asks for exists', () => {
  const { mod } = loadClient()
  const dictionaries = []
  const ctx = {
    locale: {
      register: (ns, locale, dict) => { dictionaries.push({ ns, locale, dict }) },
      bind: () => key => key,
      subscribe: () => () => {},
      getSnapshot: () => ({ active: 'en', locales: [], revision: 1 }),
    },
    slots: { inject: (slot, callback) => callback(), register: () => {} },
  }
  mod.apply(ctx)
  const dict = dictionaries[0].dict
  const keys = [...source.matchAll(/\bt\('([^']+)'\)/g)].map(match => match[1])
  assert.ok(keys.length > 0, 'the page uses the translator')
  for (const key of new Set(keys)) {
    assert.ok(Object.hasOwn(dict, key), `missing dictionary key: ${key}`)
  }
})
