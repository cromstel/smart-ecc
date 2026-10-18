/**
 * Regression tests for OpenCode plugin discovery.
 *
 * OpenCode discovers plugins by scanning the `plugins/` directory independently
 * of `opencode.json`, and it also loads the `plugins` directory alias and any
 * configured entry. A real barrel in `plugins/index.ts` therefore registered
 * every ECC hook a second (and third) time. The barrel must stay inert, and the
 * published package root must re-export the real plugin directly from
 * `plugins/ecc-hooks.ts`.
 *
 * Run standalone: node tests/opencode-plugin-discovery.test.js
 */

'use strict'

const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')

const repoRoot = path.resolve(__dirname, '..')

async function loadModule(relativePath) {
  return import(pathToFileURL(path.join(repoRoot, relativePath)).href)
}

async function runTests() {
  let passed = 0
  let failed = 0
  const test = async (name, fn) => {
    try {
      await fn()
      passed++
      console.log(`  ✓ ${name}`)
    } catch (error) {
      failed++
      console.error(`  ✗ ${name}`)
      console.error(`    ${error.stack || error.message}`)
    }
  }

  const build = spawnSync('node', [path.join(repoRoot, 'scripts', 'build-opencode.js')], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  assert.strictEqual(build.status, 0, build.stderr || build.stdout)

  await test('plugins/index.ts compiles to an inert barrel that registers no hooks', async () => {
    const barrel = await loadModule(path.join('.opencode', 'dist', 'plugins', 'index.js'))
    assert.deepStrictEqual(Object.keys(barrel).sort(), ['default'])
    const hooks = await barrel.default()
    assert.ok(hooks && typeof hooks === 'object', 'inert barrel default must return an object')
    assert.deepStrictEqual(Object.keys(hooks), [], 'inert barrel must register no hooks')
  })

  await test('package root re-exports the real dual-support plugin', async () => {
    const root = await loadModule(path.join('.opencode', 'dist', 'index.js'))
    assert.deepStrictEqual(Object.keys(root).sort(), ['default'])
    assert.strictEqual(typeof root.default, 'object', 'root default must be the plugin record')
    assert.strictEqual(typeof root.default.id, 'string')
    assert.strictEqual(typeof root.default.setup, 'function')
    assert.strictEqual(typeof root.default.server, 'function')
  })

  await test('package root source imports the plugin directly, not via the inert barrel', () => {
    const source = fs.readFileSync(path.join(repoRoot, '.opencode', 'index.ts'), 'utf8')
    assert.match(source, /from\s+["']\.\/plugins\/ecc-hooks\.ts["']/)
    assert.ok(
      !/from\s+["']\.\/plugins\/index\.ts["']/.test(source),
      'root entry must not route through the inert barrel'
    )
  })

  await test('published ./plugins subpath points at the real plugin module', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, '.opencode', 'package.json'), 'utf8'))
    const subpath = pkg.exports && pkg.exports['./plugins']
    assert.ok(subpath && typeof subpath.import === 'string', 'exports["./plugins"] must declare an import')
    assert.ok(
      subpath.import.endsWith('/dist/plugins/ecc-hooks.js'),
      `exports["./plugins"] must resolve to the real plugin module, got: ${subpath.import}`
    )
  })

  console.log(`\nPassed: ${passed}, Failed: ${failed}`)
  return failed
}

runTests().then((failed) => {
  process.exitCode = failed ? 1 : 0
})
