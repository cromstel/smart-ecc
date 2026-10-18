/**
 * Tests for the OpenCode V2 adapter (`setup(ctx)` on the default export).
 *
 * OpenCode V2 does not run V1 plugin implementations, so the plugin ships a
 * second implementation that registers on the V2 `PluginContext`. These tests
 * drive the compiled adapter with a mock context and assert the registration
 * contract: which hooks/transforms/tools are registered, what the callbacks
 * mutate, and that setup returns a cleanup function.
 */

const assert = require("node:assert")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const { pathToFileURL } = require("node:url")

function runTest(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`)
      return { passed: 1, failed: 0 }
    })
    .catch((error) => {
      console.log(`  ✗ ${name}`)
      console.error(`    ${error.stack || error.message}`)
      return { passed: 0, failed: 1 }
    })
}

async function loadPlugin() {
  const repoRoot = path.join(__dirname, "..")
  const buildResult = spawnSync("node", [path.join(repoRoot, "scripts", "build-opencode.js")], {
    cwd: repoRoot,
    encoding: "utf8",
  })
  assert.strictEqual(buildResult.status, 0, buildResult.stderr || buildResult.stdout)
  const pluginUrl = pathToFileURL(
    path.join(repoRoot, ".opencode", "dist", "plugins", "ecc-hooks.js")
  ).href
  return import(pluginUrl)
}

/**
 * Build a mock V2 `PluginContext` that records every registration.
 *
 * Only the domains the adapter touches are implemented. `event.subscribe`
 * returns an async iterable driven by the returned `emit` helper so a test can
 * push events synchronously and await delivery.
 */
function createMockContext(overrides = {}) {
  const registrations = []
  const hooks = { tool: {}, shell: {}, permission: {}, session: {} }
  const addedTools = []
  const eventQueue = []
  let abortSignal
  let resolveNext
  let streamClosed = false
  const logs = []

  const hookDomain = (name) => ({
    hook: async (hookName, callback) => {
      hooks[name][hookName] = callback
      const registration = { dispose: () => {} }
      registrations.push({ domain: name, hook: hookName, registration })
      return registration
    },
  })

  const ctx = {
    location: { directory: process.cwd() },
    app: { name: "opencode", version: "0.0.0-test" },
    options: {},
    event: {
      subscribe: (options = {}) => {
        abortSignal = options.signal
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                new Promise((resolve) => {
                  if (streamClosed) {
                    resolve({ done: true, value: undefined })
                    return
                  }
                  if (eventQueue.length > 0) {
                    resolve({ done: false, value: eventQueue.shift() })
                    return
                  }
                  resolveNext = resolve
                }),
              return: async () => {
                streamClosed = true
                resolve({ done: true, value: undefined })
                return { done: true, value: undefined }
              },
            }
          },
        }
      },
    },
    tool: {
      ...hookDomain("tool"),
      transform: async (callback) => {
        callback({
          add: (definition) => {
            addedTools.push(definition)
          },
        })
        const registration = { dispose: () => {} }
        registrations.push({ domain: "tool", hook: "transform", registration })
        return registration
      },
    },
    shell: hookDomain("shell"),
    permission: hookDomain("permission"),
    session: hookDomain("session"),
    ...overrides,
  }

  const emit = async (event) => {
    if (resolveNext) {
      const resolve = resolveNext
      resolveNext = undefined
      resolve({ done: false, value: event })
      return
    }
    eventQueue.push(event)
  }

  return {
    ctx,
    emit,
    logs,
    registrations,
    hooks,
    addedTools,
    isAborted: () => Boolean(abortSignal && abortSignal.aborted),
    endStream: () => {
      streamClosed = true
      if (resolveNext) {
        const resolve = resolveNext
        resolveNext = undefined
        resolve({ done: true, value: undefined })
      }
    },
  }
}

/** Wait for the async event pump to settle after `emit`. */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function withTempProject(fn) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-opencode-v2-"))
  try {
    return await fn(projectDir)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
}

async function main() {
  console.log("\n=== Testing OpenCode V2 plugin adapter ===\n")

  const mod = await loadPlugin()
  const plugin = mod.default
  const tests = [
    [
      "default export exposes the V2 entrypoint shape",
      async () => {
        assert.ok(plugin && typeof plugin === "object", "default export must be an object")
        assert.strictEqual(typeof plugin.id, "string")
        assert.ok(plugin.id.length > 0, "plugin id must be non-empty")
        assert.strictEqual(typeof plugin.setup, "function")
        assert.strictEqual(typeof plugin.server, "function")
      },
    ],
    [
      "setup registers every V2 hook domain and returns a cleanup function",
      async () => withTempProject(async (projectDir) => {
        const mock = createMockContext({ location: { directory: projectDir } })
        const cleanup = await plugin.setup(mock.ctx)

        assert.strictEqual(typeof cleanup, "function", "setup must return a cleanup function")
        assert.strictEqual(typeof mock.hooks.tool["execute.before"], "function")
        assert.strictEqual(typeof mock.hooks.tool["execute.after"], "function")
        assert.strictEqual(typeof mock.hooks.shell["create.before"], "function")
        assert.strictEqual(typeof mock.hooks.permission.evaluate, "function")
        assert.strictEqual(typeof mock.hooks.session.compaction, "function")

        cleanup()
        assert.ok(mock.isAborted(), "cleanup must abort the event subscription")
      }),
    ],
    [
      "setup tolerates a context that exposes no hook domains",
      async () => {
        const minimal = {
          location: { directory: process.cwd() },
          event: { subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }) },
        }
        const cleanup = await plugin.setup(minimal)
        assert.ok(cleanup === undefined || typeof cleanup === "function")
      },
    ],
    [
      "tool.execute.before mirrors the V1 PreToolUse bookkeeping",
      async () => withTempProject(async (projectDir) => {
        const mock = createMockContext({ location: { directory: projectDir } })
        const cleanup = await plugin.setup(mock.ctx)
        try {
          // A write to a not-yet-existing file must be recorded as an add when the
          // matching execute.after fires.
          await mock.hooks.tool["execute.before"]({
            tool: "write",
            callID: "call-1",
            input: { filePath: "src/new-file.ts" },
          })
          await mock.hooks.tool["execute.after"]({
            tool: "write",
            callID: "call-1",
            input: { filePath: "src/new-file.ts" },
            result: {},
          })

          const storeUrl = pathToFileURL(
            path.join(__dirname, "..", ".opencode", "dist", "plugins", "lib", "changed-files-store.js")
          ).href
          const store = await import(`${storeUrl}`)
          const changes = store.getChangedPaths()
          const recorded = changes.find((entry) => entry.path === path.normalize("src/new-file.ts"))
          assert.ok(recorded, "execute.before/after must record the written file")
          assert.strictEqual(recorded.changeType, "added")
        } finally {
          cleanup()
        }
      }),
    ],
    [
      "tool.execute.after routes skill telemetry through the shared tracker",
      async () => withTempProject(async (projectDir) => {
        const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecc-opencode-v2-home-"))
        const previousHome = process.env.HOME
        const previousUserProfile = process.env.USERPROFILE
        process.env.HOME = homeDir
        process.env.USERPROFILE = homeDir
        try {
          const mock = createMockContext({ location: { directory: projectDir } })
          const cleanup = await plugin.setup(mock.ctx)
          try {
            await mock.hooks.tool["execute.after"]({
              tool: "skill",
              callID: "call-2",
              input: { name: "code-review" },
              result: {},
            })
            const runsFilePath = path.join(homeDir, ".claude", "state", "skill-runs.jsonl")
            assert.ok(fs.existsSync(runsFilePath), "skill run must be recorded")
            const records = fs
              .readFileSync(runsFilePath, "utf8")
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line))
            assert.strictEqual(records.length, 1)
            assert.strictEqual(records[0].skill_id, "code-review")
          } finally {
            cleanup()
          }
        } finally {
          if (previousHome === undefined) delete process.env.HOME
          else process.env.HOME = previousHome
          if (previousUserProfile === undefined) delete process.env.USERPROFILE
          else process.env.USERPROFILE = previousUserProfile
          fs.rmSync(homeDir, { recursive: true, force: true })
        }
      }),
    ],
    [
      "shell.create.before injects the ECC environment",
      async () => withTempProject(async (projectDir) => {
        const mock = createMockContext({ location: { directory: projectDir } })
        const cleanup = await plugin.setup(mock.ctx)
        try {
          const event = { env: { EXISTING: "kept" } }
          mock.hooks.shell["create.before"](event)
          assert.strictEqual(event.env.EXISTING, "kept")
          assert.strictEqual(event.env.PROJECT_ROOT, projectDir)
          assert.strictEqual(event.env.ECC_PLUGIN, "true")
        } finally {
          cleanup()
        }
      }),
    ],
    [
      "permission.evaluate allows read-only actions and leaves others untouched",
      async () => withTempProject(async (projectDir) => {
        const mock = createMockContext({ location: { directory: projectDir } })
        const cleanup = await plugin.setup(mock.ctx)
        try {
          const readEvent = { action: "read", resources: ["src/index.ts"] }
          mock.hooks.permission.evaluate(readEvent)
          assert.strictEqual(readEvent.effect, "allow")

          const writeEvent = { action: "write", resources: ["src/index.ts"] }
          mock.hooks.permission.evaluate(writeEvent)
          assert.strictEqual(writeEvent.effect, undefined, "unrecognized actions stay undecided")
        } finally {
          cleanup()
        }
      }),
    ],
    [
      "session.compaction appends ECC guidance to the system prompt chunks",
      async () => withTempProject(async (projectDir) => {
        const mock = createMockContext({ location: { directory: projectDir } })
        const cleanup = await plugin.setup(mock.ctx)
        try {
          const event = { system: [] }
          mock.hooks.session.compaction(event)
          assert.ok(event.system.length > 0, "compaction must append system chunks")
          const text = event.system.map((chunk) => chunk.text).join("\n")
          assert.ok(text.includes("# ECC Context"))
          assert.ok(text.includes("Active Plugin: ECC v"))
        } finally {
          cleanup()
        }
      }),
    ],
    [
      "tool.transform registers the custom tools with JSON Schema inputs",
      async () => withTempProject(async (projectDir) => {
        const mock = createMockContext({ location: { directory: projectDir } })
        const cleanup = await plugin.setup(mock.ctx)
        try {
          const names = mock.addedTools.map((tool) => tool.name).sort()
          assert.deepStrictEqual(names, ["changed-files", "dependency-analyzer"])
          for (const tool of mock.addedTools) {
            assert.strictEqual(typeof tool.description, "string")
            assert.ok(tool.input && typeof tool.input === "object", `${tool.name} must declare a JSON Schema`)
            assert.strictEqual(typeof tool.execute, "function")
          }
        } finally {
          cleanup()
        }
      }),
    ],
    [
      "event stream dispatches session events to the runtime",
      async () => withTempProject(async (projectDir) => {
        const mock = createMockContext({ location: { directory: projectDir } })
        const cleanup = await plugin.setup(mock.ctx)
        try {
          // V2 events carry the payload on `data`.
          await mock.emit({ id: "e1", created: 0, type: "file.edited", data: { file: "src/stream.ts" } })
          await tick()

          const storeUrl = pathToFileURL(
            path.join(__dirname, "..", ".opencode", "dist", "plugins", "lib", "changed-files-store.js")
          ).href
          const store = await import(`${storeUrl}`)
          assert.ok(
            store
              .getChangedPaths()
              .some((entry) => entry.path === path.normalize("src/stream.ts")),
            "file.edited from the V2 event stream must be recorded"
          )
        } finally {
          cleanup()
          mock.endStream()
        }
      }),
    ],
    [
      "V1 HTTP server hook shape still works alongside the V2 entrypoint",
      async () => withTempProject(async (projectDir) => {
        const client = { app: { log: () => Promise.resolve() } }
        const $ = (strings) => {
          const error = new Error("Unexpected shell execution")
          return { then: (_r, reject) => reject(error), text: async () => { throw error } }
        }
        const hooks = await plugin.server({ client, $, directory: projectDir })
        assert.strictEqual(typeof hooks.event, "function")
        assert.strictEqual(typeof hooks["tool.execute.after"], "function")
        assert.strictEqual(typeof hooks["permission.ask"], "function")
      }),
    ],
  ]

  let passed = 0
  let failed = 0
  for (const [name, fn] of tests) {
    const result = await runTest(name, fn)
    passed += result.passed
    failed += result.failed
  }

  console.log(`\nPassed: ${passed}`)
  console.log(`Failed: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
