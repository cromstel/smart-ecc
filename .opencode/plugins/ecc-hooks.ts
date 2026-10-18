/**
 * ECC Plugin Hooks for OpenCode
 *
 * This plugin translates Claude Code hooks to OpenCode's plugin system.
 *
 * It ships BOTH supported OpenCode plugin APIs from one default export:
 *
 * - V1: OpenCode calls the default export's `server()` function and uses the
 *   `Hooks` object it returns.
 * - V2: OpenCode reads the default export's `id` and runs `setup(ctx)`, which
 *   registers hooks, transforms, tools and an event subscription on the
 *   context.
 *
 * Why both: OpenCode V2 does not run V1 plugin implementations (`server()`
 * exists only so older OpenCode keeps working). The two APIs are kept separate
 * because V2 does not translate V1 hooks into V2 hooks. The V1 object entrypoint
 * (a default export carrying `id`, `server` and `setup`) is supported by
 * OpenCode 1.18.29 and newer.
 *
 * V1 hook mapping (Claude Code -> OpenCode V1 `Hooks`):
 * - PreToolUse      -> "tool.execute.before"
 * - PostToolUse     -> "tool.execute.after"
 * - SessionStart    -> "event" (event.type === "session.created")
 * - Stop            -> "event" (event.type === "session.idle")
 * - SessionEnd      -> "event" (event.type === "session.deleted")
 * - file/todo/watch -> "event" (event.type === "file.edited" | "todo.updated" | "file.watcher.updated")
 *
 * Session, file and todo updates are delivered through the single `event`
 * hook, NOT as top-level hook keys: the V1 `Hooks` interface exposes only
 * `event`, so declaring `"session.idle"` (etc.) as a returned key silently did
 * nothing. The V2 API takes the same events through `ctx.event.subscribe()`.
 */

import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { ToolDefinition } from "@opencode-ai/plugin/tool"
import { tool } from "@opencode-ai/plugin/tool"
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import changedFilesTool from "../tools/changed-files.ts"
import dependencyAnalyzerTool from "../tools/dependency-analyzer.ts"

/**
 * Directory of this module.
 *
 * The plugin is ESM: tsc compiles it to .opencode/dist/plugins/*.js and OpenCode
 * loads the .ts directly, so `__dirname` is not defined there. Reading it used to
 * throw inside a try/catch and silently degrade the reported ECC version to the
 * default. `import.meta.url` is the ESM source of truth; the `__dirname` check is
 * kept first only so a CJS consumer of this module still resolves correctly.
 */
function resolvePluginDir(): string {
  if (typeof __dirname === "string" && __dirname) return __dirname
  return path.dirname(fileURLToPath(import.meta.url))
}

const PLUGIN_DIR = resolvePluginDir()

/**
 * Type definitions for better type safety
 */
interface ToolArgs {
  filePath?: string
  file_path?: string
  path?: string
  command?: string
  [key: string]: unknown
}

/**
 * Minimal shape of a V1 `tool.execute.before` output object.
 *
 * The mutable tool arguments live on the OUTPUT object (`output.args`), not on
 * the input. The input carries `tool`, `sessionID` and `callID` only.
 */
interface ToolExecuteBeforeOutput {
  args?: ToolArgs
}

/**
 * Event envelope accepted by the single V1 `event` hook and by the V2 event
 * subscription. V1 uses `properties`; the V2 stream shape carries `data`.
 */
interface EccEventLike {
  type: string
  properties?: Record<string, unknown>
  data?: Record<string, unknown>
}

type LogLevel = "debug" | "info" | "warn" | "error"

/** Logger shared by both adapters so diagnostics look identical. */
type EccLog = (level: LogLevel, message: string) => void

/**
 * The subset of the Bun/OpenCode `$` shell helper this plugin uses: a tagged
 * template that is awaitable and exposes `.text()`.
 */
interface ShellResult extends PromiseLike<{ stdout: string; stderr: string; exitCode: number }> {
  text(): Promise<string>
}
type ShellFn = (strings: TemplateStringsArray, ...values: unknown[]) => ShellResult

/**
 * Artifacts that identify an ECC root, one per capability this plugin needs.
 *
 * These are required runtime files, never optional content: `skills/` belongs to
 * the optional `workflow-quality` module, so probing for a skill rejected
 * supported modular installs (e.g. `platform-configs` + `hooks-runtime` without
 * `workflow-quality`) that still ship both the plugin and the tracker — silently
 * disabling skill telemetry and the shell root export for those users.
 *
 * Each probe is the exact artifact the caller is about to use, so detection is
 * layout detection rather than an authenticity control: a directory only
 * qualifies because it contains what we are going to read.
 */
const ECC_ROOT_PROBES = {
  // scripts/lib/utils.js is the shared library every scripts/ module requires.
  root: [path.join("scripts", "lib", "utils.js")],
  // What the skill-run telemetry hook imports at runtime.
  skillTracker: [path.join("scripts", "hooks", "skill-run-tracker.js")],
  // What the resolver embedded in commands requires once they read
  // CLAUDE_PLUGIN_ROOT, and the version lookup for shell.env.
  resolver: [path.join("scripts", "lib", "resolve-ecc-root.js")],
} as const

/**
 * Walk upwards from `startDir` looking for an ancestor that contains every
 * relative path in `probes`.
 *
 * The plugin ships in three layouts — `<root>/plugins` (installed), `<root>/dist/plugins`
 * (compiled) and `<repo>/.opencode/plugins` (repo checkout) — so the number of
 * levels back to the root is not fixed. Probing beats a hardcoded `..`: a wrong
 * root would make every command resolve against a directory that has no scripts.
 *
 * The walk is bounded to 5 levels so it cannot wander into unrelated ancestors.
 *
 * Returns null when no ancestor qualifies, so callers can leave the capability
 * disabled instead of advertising a root that does not hold the artifact.
 */
function findEccRootDir(startDir: string, probes: readonly string[]): string | null {
  let current = startDir
  for (let depth = 0; depth < 5; depth += 1) {
    if (probes.every((probe) => fs.existsSync(path.join(current, probe)))) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

/**
 * Read the ECC version from package.json.
 *
 * Candidates are tried in order — the resolved ECC root first, then the two
 * plausible parent depths of the plugin — because the layout differs between an
 * installed root (`<root>/plugins`), the compiled bundle (`<root>/dist/plugins`)
 * and a repo checkout (`<repo>/.opencode/plugins`). Falls back to a default if
 * no package.json can be read.
 */
function getECCVersion(eccRootDir?: string | null): string {
  const candidates = [
    eccRootDir,
    path.resolve(PLUGIN_DIR, ".."),
    path.resolve(PLUGIN_DIR, "..", ".."),
  ]

  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const packageJson = JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf-8"))
      if (typeof packageJson.version === "string" && packageJson.version) {
        return packageJson.version
      }
    } catch {
      // Try the next candidate.
    }
  }

  return "2.0.0"
}

/**
 * Strip a shell redirect that our own capture already handles.
 *
 * The shared behavior is written for Bun's `$`, where `2>/dev/null` and `2>&1`
 * are meaningful. When we emulate `$` with `child_process` we capture stderr
 * ourselves, and the POSIX redirect is not portable to Windows `cmd.exe`, so
 * remove it rather than making the command fail.
 */
function stripShellRedirect(command: string): string {
  return command.replace(/\s+2>\s*\/dev\/null\b/g, "").replace(/\s+2>&1\b/g, "")
}

/**
 * Build a `$`-compatible helper for adapters that are not handed Bun's shell
 * (the V2 context does not expose `$`).
 *
 * Only the features this plugin relies on are implemented: command execution
 * with stdout/stderr capture. Everything that uses it is best-effort and already
 * wrapped in try/catch by the caller.
 */
function createNodeShell(): ShellFn {
  const run = (command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
    new Promise((resolve, reject) => {
      const { spawn } = require("node:child_process") as typeof import("node:child_process")
      const child = spawn(stripShellRedirect(command), {
        shell: true,
        windowsHide: true,
      })
      let stdout = ""
      let stderr = ""
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk)
      })
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk)
      })
      child.on("error", reject)
      child.on("close", (code) => {
        if (code && code !== 0) {
          const error = Object.assign(new Error(`Command failed: ${command}`), {
            stdout,
            stderr,
            exitCode: code,
          })
          reject(error)
          return
        }
        resolve({ stdout, stderr, exitCode: code ?? 0 })
      })
    })

  return (strings: TemplateStringsArray, ...values: unknown[]): ShellResult => {
    let command = strings[0] ?? ""
    for (let index = 0; index < values.length; index += 1) {
      command += `${String(values[index])}${strings[index + 1] ?? ""}`
    }
    const promise = run(command)
    const result: ShellResult = {
      // Awaiting the tagged template resolves to the captured command result.
      then: (onFulfilled, onRejected) => promise.then(onFulfilled, onRejected),
      text: async () => (await promise).stdout,
    }
    return result
  }
}

/**
 * Shared, adapter-independent ECC behavior.
 *
 * Both the V1 `server()` hooks and the V2 `setup()` hooks are thin translators
 * over this object, so a behavior fix lands in both at once instead of drifting.
 */
interface EccRuntime {
  readonly toolDefinitions: Record<string, ToolDefinition>
  onFileEdited(filePath: string): Promise<void>
  onToolBefore(tool: string, callID: string, args: ToolArgs | undefined): Promise<void>
  onToolAfter(tool: string, callID: string, args: ToolArgs | undefined, result: unknown): Promise<void>
  buildShellEnv(existing: Record<string, string>): Record<string, string>
  buildCompactionContext(): string[]
  /** Returns the permission effect this plugin wants, or undefined to leave it alone. */
  evaluatePermission(type: string, pattern: string | undefined): "allow" | "deny" | undefined
  onSessionCreated(): Promise<void>
  onSessionIdle(): Promise<void>
  onSessionDeleted(): void
  onFileWatcherUpdated(file: string, event: string): void
  onTodoUpdated(todos: Array<{ content?: string; status?: string }>): void
  /** Route a raw event envelope from either API to the matching behavior. */
  handleEvent(event: EccEventLike): Promise<void>
}

interface RuntimeOptions {
  log: EccLog
  $: ShellFn
  directory: string
  worktree?: string
}

async function createRuntime(options: RuntimeOptions): Promise<EccRuntime> {
  const { log, $ } = options
  const worktreePath = options.worktree || options.directory

  type HookProfile = "minimal" | "standard" | "strict"

  const editedFiles = new Set<string>()

  function resolvePath(p: string): string {
    if (path.isAbsolute(p)) return p
    return path.join(worktreePath, p)
  }

  function hasProjectFile(relativePath: string): boolean {
    try {
      return fs.statSync(resolvePath(relativePath)).isFile()
    } catch {
      return false
    }
  }

  const pendingToolChanges = new Map<string, { path: string; type: "added" | "modified" }>()
  let writeCounter = 0

  function getFilePath(args: ToolArgs | undefined): string | null {
    if (!args) return null
    const p = (args.filePath ?? args.file_path ?? args.path) as string | undefined
    return typeof p === "string" && p.trim() ? p : null
  }

  // Loaded lazily (instead of via a top-level import) so that a missing or
  // partially-installed `~/.opencode/plugins/lib` directory (e.g. an
  // interrupted or partial ECC install on Termux/Android) only disables
  // changed-files tracking, rather than throwing during module evaluation.
  // This plugin is OpenCode's startup entry point, so a static import
  // failure here previously crashed the whole plugin -- and with it, the
  // entire OpenCode session -- before any hooks could load (see #2530).
  let changedFilesStore: typeof import("./lib/changed-files-store.ts") | undefined
  try {
    const store = await import("./lib/changed-files-store.ts")
    store.initStore(worktreePath)
    changedFilesStore = store
  } catch {
    // Best-effort diagnostic only: deferred via .then() (rather than
    // Promise.resolve(log(...))) so that even a *synchronous* throw inside
    // log() -- not just an async rejection -- is caught here instead of
    // escaping this catch block. The raw loader error is intentionally not
    // included in the message since it can contain absolute filesystem
    // paths; this whole block exists to guarantee startup resilience even
    // when things go wrong.
    Promise.resolve()
      .then(() =>
        log(
          "warn",
          "[ECC] changed-files tracking disabled: could not load the changed-files store. " +
            "Run `ecc repair --target opencode` to restore the missing files. Other ECC hooks are unaffected."
        )
      )
      .catch(() => {})
  }

  // Claude Code routes post:skill:track through
  // scripts/hooks/posttooluse-dispatcher.js, which OpenCode never invokes.
  // Without a caller here, nothing ever writes skill-runs.jsonl and
  // `skills-health.js --dashboard` has no data to report on any skill (#2463).
  //
  // The tracker module is reused rather than reimplemented so its identifier
  // validation, length bounds and "never persist prompt text" guarantees stay
  // the ones that were written and audited for the Claude Code path.
  //
  // Loaded lazily, for the same reason as the store above: this file is
  // OpenCode's startup entry point, and a static import of a missing module
  // crashes the plugin -- and with it the whole session -- before any hook can
  // run (#2530). A runtime file URL also keeps tsc from resolving a relative
  // specifier that exists in no compiled layout.
  type SkillRunTrackerModule = { run?: (payload: unknown) => void }
  let recordSkillRun: ((payload: unknown) => void) | undefined
  // Detection is scoped to the tracker itself, so a modular install that omits
  // optional content still gets telemetry.
  const trackerRoot = findEccRootDir(PLUGIN_DIR, ECC_ROOT_PROBES.skillTracker)
  // The root advertised to commands is a different question: those commands
  // require the resolver, so a root without it would break them again.
  const eccRoot =
    findEccRootDir(PLUGIN_DIR, ECC_ROOT_PROBES.resolver) ?? findEccRootDir(PLUGIN_DIR, ECC_ROOT_PROBES.root)
  try {
    const trackerPath = trackerRoot
      ? path.join(trackerRoot, "scripts", "hooks", "skill-run-tracker.js")
      : null
    if (!trackerPath || !fs.existsSync(trackerPath)) {
      throw new Error("skill-run-tracker.js not found")
    }
    // CJS module loaded from ESM: run() is on the namespace in Node/Bun, but a
    // transpiled default export must stay supported.
    const loaded = (await import(pathToFileURL(trackerPath).href)) as SkillRunTrackerModule & {
      default?: SkillRunTrackerModule
    }
    const entry = typeof loaded.run === "function" ? loaded : loaded.default
    if (!entry || typeof entry.run !== "function") {
      throw new Error("skill-run-tracker.js exposes no run()")
    }
    recordSkillRun = entry.run
  } catch {
    // Same deferred-log rationale as the store above: guarantee that a
    // telemetry failure can never escape this catch and abort startup.
    Promise.resolve()
      .then(() =>
        log(
          "warn",
          "[ECC] skill-run telemetry disabled: could not load scripts/hooks/skill-run-tracker.js. " +
            "Run `ecc repair --target opencode` to restore the missing files. Other ECC hooks are unaffected."
        )
      )
      .catch(() => {})
  }

  const normalizeProfile = (value: string | undefined): HookProfile => {
    if (value === "minimal" || value === "strict") return value
    return "standard"
  }

  const currentProfile = normalizeProfile(process.env.ECC_HOOK_PROFILE)
  const disabledHooks = new Set(
    (process.env.ECC_DISABLED_HOOKS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  )

  const profileOrder: Record<HookProfile, number> = {
    minimal: 0,
    standard: 1,
    strict: 2,
  }

  const profileAllowed = (required: HookProfile | HookProfile[]): boolean => {
    if (Array.isArray(required)) {
      return required.some((entry) => profileOrder[currentProfile] >= profileOrder[entry])
    }
    return profileOrder[currentProfile] >= profileOrder[required]
  }

  const hookEnabled = (
    hookId: string,
    requiredProfile: HookProfile | HookProfile[] = "standard"
  ): boolean => {
    if (disabledHooks.has(hookId)) return false
    return profileAllowed(requiredProfile)
  }

  /**
   * Prettier Auto-Format + console.log warning, equivalent to Claude Code's
   * PostToolUse hook. Triggered for every edited JS/TS file.
   */
  async function onFileEdited(filePath: string): Promise<void> {
    editedFiles.add(filePath)
    changedFilesStore?.recordChange(filePath, "modified")

    // Auto-format JS/TS files
    if (hookEnabled("post:edit:format", ["strict"]) && filePath.match(/\.(ts|tsx|js|jsx)$/)) {
      try {
        await $`prettier --write ${filePath} 2>/dev/null`
        log("info", `[ECC] Formatted: ${filePath}`)
      } catch (error: unknown) {
        // Prettier not installed or failed - log but continue
        const errorMessage = error instanceof Error ? error.message : String(error)
        log("debug", `[ECC] Prettier formatting failed for ${filePath}: ${errorMessage}`)
      }
    }

    // Console.log warning check
    if (hookEnabled("post:edit:console-warn", ["standard", "strict"]) && filePath.match(/\.(ts|tsx|js|jsx)$/)) {
      try {
        const result = await $`grep -n "console\\.log" ${filePath} 2>/dev/null`.text()
        if (result.trim()) {
          const lines = result.trim().split("\n").length
          log(
            "warn",
            `[ECC] console.log found in ${filePath} (${lines} occurrence${lines > 1 ? "s" : ""})`
          )
        }
      } catch {
        // No console.log found (grep returns non-zero) - this is good
      }
    }
  }

  /**
   * Pre-tool bookkeeping, equivalent to Claude Code's PreToolUse hook.
   */
  async function onToolBefore(toolName: string, callID: string, args: ToolArgs | undefined): Promise<void> {
    if (toolName === "write") {
      const filePath = getFilePath(args)
      if (filePath) {
        const absPath = resolvePath(filePath)
        let type: "added" | "modified" = "modified"
        try {
          if (typeof fs.existsSync === "function") {
            type = fs.existsSync(absPath) ? "modified" : "added"
          }
        } catch {
          type = "modified"
        }
        const key = callID || `write-${++writeCounter}-${filePath}`
        pendingToolChanges.set(key, { path: filePath, type })
      }
    }

    // Git push review reminder
    if (hookEnabled("pre:bash:git-push-reminder", "strict") && toolName === "bash") {
      const command = getCommandString(args)
      if (command.includes("git push")) {
        log(
          "info",
          "[ECC] Remember to review changes before pushing: git diff origin/main...HEAD"
        )
      }
    }

    // Block creation of unnecessary documentation files
    if (hookEnabled("pre:write:doc-file-warning", ["standard", "strict"]) && toolName === "write") {
      const filePath = getFilePath(args)
      if (
        filePath &&
        filePath.match(/\.(md|txt)$/i) &&
        !filePath.includes("README") &&
        !filePath.includes("CHANGELOG") &&
        !filePath.includes("LICENSE") &&
        !filePath.includes("CONTRIBUTING")
      ) {
        log(
          "warn",
          `[ECC] Creating ${filePath} - consider if this documentation is necessary`
        )
      }
    }

    // Long-running command reminder
    if (hookEnabled("pre:bash:tmux-reminder", "strict") && toolName === "bash") {
      const command = getCommandString(args)
      if (
        command.match(/^(npm|pnpm|yarn|bun)\s+(install|build|test|run)/) ||
        command.match(/^cargo\s+(build|test|run)/) ||
        command.match(/^go\s+(build|test|run)/)
      ) {
        log(
          "info",
          "[ECC] Long-running command detected - consider using background execution"
        )
      }
    }
  }

  function getCommandString(args: ToolArgs | undefined): string {
    if (!args) return ""
    const command = args.command
    if (typeof command === "string") return command
    try {
      return String(args)
    } catch {
      return ""
    }
  }

  /**
   * Post-tool bookkeeping + strict TypeScript check, equivalent to Claude Code's
   * PostToolUse hook.
   */
  async function onToolAfter(
    toolName: string,
    callID: string,
    args: ToolArgs | undefined,
    result: unknown
  ): Promise<void> {
    const filePath = getFilePath(args)
    if (toolName === "edit" && filePath) {
      changedFilesStore?.recordChange(filePath, "modified")
    }
    if (toolName === "write" && filePath) {
      const key = callID || `write-${++writeCounter}-${filePath}`
      const pending = pendingToolChanges.get(key)
      if (pending) {
        changedFilesStore?.recordChange(pending.path, pending.type)
        pendingToolChanges.delete(key)
      } else {
        changedFilesStore?.recordChange(filePath, "modified")
      }
    }

    // Check if a TypeScript file was edited
    if (
      hookEnabled("post:edit:typecheck", ["strict"]) &&
      toolName === "edit" &&
      typeof args?.filePath === "string" &&
      args.filePath.match(/\.tsx?$/)
    ) {
      try {
        await $`npx tsc --noEmit 2>&1`
        log("info", "[ECC] TypeScript check passed")
      } catch (error: unknown) {
        const err = error as { stdout?: string }
        log("warn", "[ECC] TypeScript errors detected:")
        if (err.stdout) {
          // Log first few errors
          const errors = err.stdout.split("\n").slice(0, 5)
          errors.forEach((line: string) => log("warn", `  ${line}`))
        }
      }
    }

    // PR creation logging
    if (
      hookEnabled("post:bash:pr-created", ["standard", "strict"]) &&
      toolName === "bash" &&
      getCommandString(args).includes("gh pr create")
    ) {
      log("info", "[ECC] PR created - check GitHub Actions status")
    }

    // Skill telemetry (#2463). OpenCode's tool is named `skill`, so the
    // harness-side name is matched here (case-insensitively) and the payload
    // is handed over in the shape the tracker already understands.
    if (
      hookEnabled("post:skill:track", ["standard", "strict"]) &&
      typeof toolName === "string" &&
      toolName.trim().toLowerCase() === "skill"
    ) {
      try {
        recordSkillRun?.({
          tool_name: "Skill",
          tool_input: args ?? {},
          tool_response: result,
        })
      } catch {
        // Telemetry is best-effort; never let it affect the tool result.
      }
    }
  }

  /**
   * Build the environment variables this plugin injects into shell commands.
   *
   * Returns a fresh object; the caller owns merging it into the host's env so
   * neither API's output object is mutated here.
   */
  function buildShellEnv(existing: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {
      ECC_VERSION: getECCVersion(eccRoot),
      ECC_PLUGIN: "true",
      ECC_HOOK_PROFILE: currentProfile,
      ECC_DISABLED_HOOKS: process.env.ECC_DISABLED_HOOKS || "",
      PROJECT_ROOT: worktreePath,
    }

    // Detect package manager
    const lockfiles: Record<string, string> = {
      "bun.lockb": "bun",
      "pnpm-lock.yaml": "pnpm",
      "yarn.lock": "yarn",
      "package-lock.json": "npm",
    }
    for (const [lockfile, pm] of Object.entries(lockfiles)) {
      if (hasProjectFile(lockfile)) {
        env.PACKAGE_MANAGER = pm
        break
      }
    }

    // Detect languages
    const langDetectors: Record<string, string> = {
      "tsconfig.json": "typescript",
      "go.mod": "go",
      "pyproject.toml": "python",
      "Cargo.toml": "rust",
      "Package.swift": "swift",
    }
    const detected: string[] = []
    for (const [file, lang] of Object.entries(langDetectors)) {
      if (hasProjectFile(file)) {
        detected.push(lang)
      }
    }
    if (detected.length > 0) {
      env.DETECTED_LANGUAGES = detected.join(",")
      env.PRIMARY_LANGUAGE = detected[0]
    }

    // resolve-ecc-root.js only probes ~/.claude and Claude Code's plugin
    // cache, so under OpenCode it fell back to ~/.claude and every command
    // carrying the inlined resolver failed to find its scripts. That resolver
    // reads CLAUDE_PLUGIN_ROOT first, so exporting the root here fixes them
    // through the mechanism ECC already provides -- rather than editing the
    // command files that embed the locator.
    //
    // Only set when a root actually exists, and never replace a root someone
    // else already chose: neither the process environment (set by the user)
    // nor the host's output env (set by an earlier plugin).
    const rootAlreadySet = Boolean(
      (process.env.CLAUDE_PLUGIN_ROOT || "").trim() || (existing.CLAUDE_PLUGIN_ROOT || "").trim()
    )
    if (eccRoot && !rootAlreadySet) {
      env.CLAUDE_PLUGIN_ROOT = eccRoot
    }

    return env
  }

  /**
   * Context strings pushed into the host's compaction prompt so ECC guidance
   * survives context compaction.
   */
  function buildCompactionContext(): string[] {
    const contextBlock = [
      "# ECC Context (preserve across compaction)",
      "",
      // Marker literal kept in sync by scripts/release.sh and asserted by
      // tests/plugin-manifest.test.js; do not replace it with an expression.
      "## Active Plugin: ECC v2.2.3",
      "- Hooks: event (file.edited, session.created/idle/deleted, todo.updated, file.watcher.updated),",
      "  tool.execute.before/after, shell.env, experimental.session.compacting, permission.ask",
      "- Tools: run-tests, check-coverage, security-audit, format-code, lint-check, git-summary, changed-files, dependency-analyzer",
      "",
      "## Key Principles",
      "- TDD: write tests first, 80%+ coverage",
      "- Immutability: never mutate, always return new copies",
      "- Security: validate inputs, no hardcoded secrets",
      "",
    ]

    // Include recently edited files
    if (editedFiles.size > 0) {
      contextBlock.push("## Recently Edited Files")
      for (const f of editedFiles) {
        contextBlock.push(`- ${f}`)
      }
      contextBlock.push("")
    }

    return [
      contextBlock.join("\n"),
      "Focus on preserving: 1) Current task status and progress, 2) Key decisions made, 3) Files created/modified, 4) Remaining work items, 5) Any security concerns flagged. Discard: verbose tool outputs, intermediate exploration, redundant file listings.",
    ]
  }

  /**
   * Decide whether to auto-approve an operation.
   *
   * `type`/`pattern` come from the V1 `Permission` object (`type` + `pattern`);
   * the V2 permission hook passes its `action` and `resources` in the same shape.
   * Anything not recognized is left to the user (returns undefined).
   */
  function evaluatePermission(type: string, pattern: string | undefined): "allow" | "deny" | undefined {
    const readOnlyTypes = ["read", "glob", "grep", "search", "list"]
    if (readOnlyTypes.includes(type)) {
      return "allow"
    }

    if (type === "bash" || type === "shell") {
      const command = pattern || ""
      if (/^(npx )?(@biomejs\/biome|prettier|black|gofmt|rustfmt|swift-format)/.test(command)) {
        return "allow"
      }
      if (/^(npm test|npx vitest|npx jest|pytest|go test|cargo test)/.test(command)) {
        return "allow"
      }
    }

    return undefined
  }

  async function onSessionCreated(): Promise<void> {
    if (!hookEnabled("session:start", ["minimal", "standard", "strict"])) return

    log("info", `[ECC] Session started - profile=${currentProfile}`)

    // Check for project-specific context files
    if (hasProjectFile("CLAUDE.md")) {
      log("info", "[ECC] Found CLAUDE.md - loading project context")
    }
  }

  /**
   * Equivalent to Claude Code's Stop hook: audit edited files for console.log
   * and notify that the task completed.
   */
  async function onSessionIdle(): Promise<void> {
    if (!hookEnabled("stop:check-console-log", ["minimal", "standard", "strict"])) return
    if (editedFiles.size === 0) return

    log("info", "[ECC] Session idle - running console.log audit")

    let totalConsoleLogCount = 0
    const filesWithConsoleLogs: string[] = []

    for (const file of editedFiles) {
      if (!file.match(/\.(ts|tsx|js|jsx)$/)) continue

      try {
        const result = await $`grep -c "console\\.log" ${file} 2>/dev/null`.text()
        const count = parseInt(result.trim(), 10)
        if (count > 0) {
          totalConsoleLogCount += count
          filesWithConsoleLogs.push(file)
        }
      } catch {
        // No console.log found
      }
    }

    if (totalConsoleLogCount > 0) {
      log(
        "warn",
        `[ECC] Audit: ${totalConsoleLogCount} console.log statement(s) in ${filesWithConsoleLogs.length} file(s)`
      )
      filesWithConsoleLogs.forEach((f) => log("warn", `  - ${f}`))
      log("warn", "[ECC] Remove console.log statements before committing")
    } else {
      log("info", "[ECC] Audit passed: No console.log statements found")
    }

    // Desktop notification (cross-platform)
    try {
      if (process.platform === "darwin") {
        // macOS
        await $`osascript -e 'display notification "Task completed!" with title "OpenCode ECC"' 2>/dev/null`
      } else if (process.platform === "win32") {
        // Windows - PowerShell notification
        await $`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('Task completed!', 'OpenCode ECC', 'OK', 'Information')" 2>/dev/null`
      } else if (process.platform === "linux") {
        // Linux - notify-send (requires libnotify)
        await $`notify-send "OpenCode ECC" "Task completed!" 2>/dev/null`
      }
    } catch (error: unknown) {
      // Notification not supported or failed - log but continue
      const errorMessage = error instanceof Error ? error.message : String(error)
      log("debug", `[ECC] Desktop notification failed: ${errorMessage}`)
    }

    // Clear tracked files for next task
    editedFiles.clear()
  }

  function onSessionDeleted(): void {
    if (!hookEnabled("session:end-marker", ["minimal", "standard", "strict"])) return
    log("info", "[ECC] Session ended - cleaning up")
    editedFiles.clear()
    changedFilesStore?.clearChanges()
    pendingToolChanges.clear()
  }

  function onFileWatcherUpdated(file: string, event: string): void {
    let changeType: "added" | "modified" | "deleted" = "modified"
    if (event === "add" || event === "create") changeType = "added"
    else if (event === "unlink" || event === "delete" || event === "remove") changeType = "deleted"
    changedFilesStore?.recordChange(file, changeType)
    if ((event === "change" || changeType === "modified") && file.match(/\.(ts|tsx|js|jsx)$/)) {
      editedFiles.add(file)
    }
  }

  function onTodoUpdated(todos: Array<{ content?: string; status?: string }>): void {
    const completed = todos.filter((todo) => todo.status === "completed").length
    const total = todos.length
    if (total > 0) {
      log("info", `[ECC] Progress: ${completed}/${total} tasks completed`)
    }
  }

  /**
   * Route an event envelope from either API to the matching behavior.
   *
   * V1 emits `{ type, properties }`; the V2 event stream carries the payload on
   * `data`. Both are accepted so a single dispatcher serves both adapters, and
   * unknown types are ignored instead of throwing.
   */
  async function handleEvent(event: EccEventLike): Promise<void> {
    if (!event || typeof event.type !== "string") return
    const payload = (event.properties ?? event.data ?? {}) as Record<string, unknown>

    switch (event.type) {
      case "file.edited": {
        const file = payload.file ?? payload.path
        if (typeof file === "string") await onFileEdited(file)
        break
      }
      case "file.watcher.updated": {
        const file = payload.file ?? payload.path
        const kind = payload.event ?? payload.type
        if (typeof file === "string") onFileWatcherUpdated(file, String(kind ?? "change"))
        break
      }
      case "session.created":
        await onSessionCreated()
        break
      case "session.idle":
        await onSessionIdle()
        break
      case "session.deleted":
        onSessionDeleted()
        break
      case "todo.updated": {
        const todos = Array.isArray(payload.todos) ? (payload.todos as Array<{ content?: string; status?: string }>) : []
        onTodoUpdated(todos)
        break
      }
      default:
        break
    }
  }

  const toolDefinitions: Record<string, ToolDefinition> = {
    "changed-files": changedFilesTool,
    "dependency-analyzer": dependencyAnalyzerTool,
  }

  return {
    toolDefinitions,
    onFileEdited,
    onToolBefore,
    onToolAfter,
    buildShellEnv,
    buildCompactionContext,
    evaluatePermission,
    onSessionCreated,
    onSessionIdle,
    onSessionDeleted,
    onFileWatcherUpdated,
    onTodoUpdated,
    handleEvent,
  }
}

/**
 * OpenCode V1 plugin implementation.
 *
 * Returns the V1 `Hooks` object. Everything the V1 `Hooks` interface does not
 * declare as a named key (session, file and todo updates) is delivered through
 * the single `event` hook.
 */
export const ECCHooksPlugin = async (input: PluginInput): Promise<Hooks> => {
  const log: EccLog = (level, message) =>
    input.client.app.log({ body: { service: "ecc", level, message } })

  const runtime = await createRuntime({
    log,
    $: input.$ as unknown as ShellFn,
    directory: input.directory,
    worktree: input.worktree,
  })

  return {
    /**
     * Single event entry point. V1 delivers session/file/todo updates here.
     */
    event: async ({ event }) => {
      await runtime.handleEvent(event as unknown as EccEventLike)
    },

    /**
     * TypeScript check + skill telemetry, equivalent to Claude Code's
     * PostToolUse hook. `args` is on the input for `execute.after`.
     */
    "tool.execute.after": async (input, _output) => {
      await runtime.onToolAfter(
        input.tool,
        input.callID,
        input.args as ToolArgs | undefined,
        _output as unknown
      )
    },

    /**
     * Pre-tool bookkeeping, equivalent to Claude Code's PreToolUse hook.
     *
     * The mutable tool arguments live on the OUTPUT object: `input` carries only
     * `tool`, `sessionID` and `callID`.
     */
    "tool.execute.before": async (input, output) => {
      const target = output as ToolExecuteBeforeOutput
      await runtime.onToolBefore(input.tool, input.callID, target.args)
    },

    /**
     * Shell environment injection.
     *
     * OpenCode reads the supplied output object and ignores callback return
     * values, so the merged env is assigned back onto `output.env`.
     */
    "shell.env": async (_input, output) => {
      const injected = runtime.buildShellEnv(output.env ?? {})
      output.env = { ...output.env, ...injected }
    },

    /**
     * Push ECC guidance into the host's compaction prompt.
     *
     * OpenCode requires output assignment and skips `context` when a prompt is
     * set, so a host-supplied prompt is extended rather than replaced.
     */
    "experimental.session.compacting": async (_input, output) => {
      const eccContext = runtime.buildCompactionContext()
      if (output.prompt !== undefined) {
        output.prompt = [output.prompt, ...eccContext].join("\n\n")
      } else {
        output.context = [...output.context, ...eccContext]
      }
    },

    /**
     * Permission evaluation, equivalent to Claude Code's permission phase.
     *
     * V1 passes a `Permission` (`type` + `pattern`) and expects the decision to
     * be written on the OUTPUT object as `status`. Returning a value does
     * nothing.
     */
    "permission.ask": async (input, output) => {
      try {
        const type = typeof input.type === "string" ? input.type : ""
        const pattern = Array.isArray(input.pattern) ? input.pattern.join(" ") : input.pattern
        log("info", `[ECC] Permission requested for: ${type}`)

        const decision = runtime.evaluatePermission(type, pattern)
        if (decision) {
          output.status = decision
          log("debug", `[ECC] Auto-approved ${type}: ${pattern ?? ""}`)
        }
      } catch (error: unknown) {
        // Error in permission handling - log and deny for safety
        const errorMessage = error instanceof Error ? error.message : String(error)
        log("error", `[ECC] Permission handling error: ${errorMessage}`)
        output.status = "deny"
      }
    },

    tool: runtime.toolDefinitions,
  }
}

/**
 * OpenCode V2 plugin context — the subset of domains this plugin registers on.
 *
 * Typed locally (instead of importing `@opencode/plugin`, which is not a
 * dependency of this package) and consumed defensively: a domain that a given
 * OpenCode build does not expose is skipped rather than throwing during setup.
 */
interface V2RegistrationLike {
  dispose?: () => Promise<void> | void
}

interface V2ToolEditorLike {
  add(definition: {
    name: string
    description: string
    input: Record<string, unknown>
    execute: (input: unknown, context: unknown) => Promise<{ content: string }>
  }): void
}

/** Hook/transform registration surface shared by the V2 domains we use. */
interface V2HookDomainLike {
  hook?: (name: string, callback: (event: any) => Promise<void> | void) => Promise<V2RegistrationLike>
}

interface V2ContextLike {
  location?: { directory?: string; project?: { id?: string; directory?: string } }
  app?: { name?: string; version?: string }
  options?: Record<string, unknown>
  event?: {
    subscribe?: (options?: { signal?: AbortSignal }) => AsyncIterable<unknown>
  }
  tool?: V2HookDomainLike & {
    transform?: (callback: (editor: V2ToolEditorLike) => void) => Promise<V2RegistrationLike>
  }
  shell?: V2HookDomainLike
  permission?: V2HookDomainLike
  session?: V2HookDomainLike
}

/**
 * Convert a V1 tool's zod argument shape to the JSON Schema a V2 tool expects.
 *
 * Returns null when the shape cannot be converted, so the caller skips that tool
 * instead of registering one with a wrong (or absent) schema.
 */
function toolArgsToJsonSchema(args: unknown): Record<string, unknown> | null {
  try {
    const schema = tool.schema as unknown as {
      object: (shape: Record<string, unknown>) => unknown
      toJSONSchema: (value: unknown) => Record<string, unknown>
    }
    if (!schema || typeof schema.toJSONSchema !== "function") return null
    const shape = args && typeof args === "object" ? (args as Record<string, unknown>) : {}
    const json = schema.toJSONSchema(schema.object(shape))
    if (!json || typeof json !== "object") return null
    const { $schema: _ignored, ...rest } = json
    return rest
  } catch {
    return null
  }
}

/**
 * Register the V2 implementation of every ECC behavior on the plugin context.
 *
 * Each domain is registered inside its own guard so an OpenCode build that
 * lacks one domain still gets every other hook, and one failing registration
 * cannot abort plugin setup.
 */
async function registerV2Hooks(ctx: V2ContextLike, runtime: EccRuntime, log: EccLog): Promise<void> {
  const guarded = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    try {
      await action()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      log("warn", `[ECC] OpenCode V2 ${label} hook unavailable: ${message}`)
    }
  }

  // Tools: execute.before mirrors the V1 PreToolUse hook.
  await guarded("tool.execute.before", async () => {
    if (typeof ctx.tool?.hook !== "function") return
    await ctx.tool.hook("execute.before", async (event: any) => {
      const input = (event?.input ?? {}) as ToolArgs
      await runtime.onToolBefore(String(event?.tool ?? ""), String(event?.callID ?? ""), input)
    })
  })

  // Tools: execute.after mirrors the V1 PostToolUse hook.
  await guarded("tool.execute.after", async () => {
    if (typeof ctx.tool?.hook !== "function") return
    await ctx.tool.hook("execute.after", async (event: any) => {
      const result = event?.status === "error" ? event?.error : event?.result
      await runtime.onToolAfter(
        String(event?.tool ?? ""),
        String(event?.callID ?? ""),
        (event?.input ?? {}) as ToolArgs,
        result
      )
    })
  })

  // Shell environment injection.
  await guarded("shell.create.before", async () => {
    if (typeof ctx.shell?.hook !== "function") return
    await ctx.shell.hook("create.before", (event: any) => {
      if (!event || typeof event !== "object") return
      const existing = (event.env ?? {}) as Record<string, string>
      event.env = { ...existing, ...runtime.buildShellEnv(existing) }
    })
  })

  // Permission evaluation.
  await guarded("permission.evaluate", async () => {
    if (typeof ctx.permission?.hook !== "function") return
    await ctx.permission.hook("evaluate", (event: any) => {
      if (!event || typeof event !== "object") return
      const action = typeof event.action === "string" ? event.action : ""
      const resources = Array.isArray(event.resources) ? event.resources.join(" ") : undefined
      const decision = runtime.evaluatePermission(action, resources)
      if (decision) event.effect = decision
    })
  })

  // Compaction guidance.
  await guarded("session.compaction", async () => {
    if (typeof ctx.session?.hook !== "function") return
    await ctx.session.hook("compaction", (event: any) => {
      if (!event || !Array.isArray(event.system)) return
      for (const chunk of runtime.buildCompactionContext()) {
        event.system.push({ type: "text", text: chunk })
      }
    })
  })

  // Custom tools, converted from the V1 zod shapes to JSON Schema.
  await guarded("tool.transform", async () => {
    if (typeof ctx.tool?.transform !== "function") return
    const definitions = Object.entries(runtime.toolDefinitions)
      .map(([name, definition]) => ({ name, definition, input: toolArgsToJsonSchema(definition.args) }))
      .filter((entry): entry is { name: string; definition: ToolDefinition; input: Record<string, unknown> } =>
        entry.input !== null
      )

    const skipped = Object.keys(runtime.toolDefinitions).length - definitions.length
    if (skipped > 0) {
      log("warn", `[ECC] ${skipped} custom tool(s) skipped under OpenCode V2: no JSON Schema could be derived.`)
    }

    await ctx.tool.transform((editor) => {
      for (const { name, definition, input } of definitions) {
        editor.add({
          name,
          description: definition.description,
          input,
          execute: async (args: unknown) => {
            const output = await definition.execute(args as never, {} as never)
            return { content: typeof output === "string" ? output : output.output }
          },
        })
      }
    })
  })
}

/**
 * OpenCode V2 plugin setup.
 *
 * Subscribes to the public event stream and returns the cleanup function V2
 * expects. The subscription is aborted during plugin unload.
 */
export async function setup(ctx: V2ContextLike): Promise<(() => void) | void> {
  const log: EccLog = (level, message) => {
    try {
      process.stderr.write(`[ecc][${level}] ${message}\n`)
    } catch {
      // Never let diagnostics break setup.
    }
  }

  const directory = ctx?.location?.directory || process.cwd()

  let runtime: EccRuntime
  try {
    runtime = await createRuntime({
      log,
      $: createNodeShell(),
      directory,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    log("error", `[ECC] OpenCode V2 setup failed: ${message}`)
    return
  }

  await registerV2Hooks(ctx, runtime, log)

  if (typeof ctx?.event?.subscribe !== "function") return

  const controller = new AbortController()
  void (async () => {
    try {
      for await (const raw of ctx.event!.subscribe!({ signal: controller.signal })) {
        await runtime.handleEvent(raw as EccEventLike)
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      log("debug", `[ECC] OpenCode V2 event stream ended: ${message}`)
    }
  })()

  return () => controller.abort()
}

/**
 * Dual-API default export.
 *
 * V1 calls `server()` and uses the returned hooks; V2 reads `id` and runs
 * `setup()`.
 */
const ECCPlugin = {
  id: "ecc",
  setup,
  server: ECCHooksPlugin,
}

export default ECCPlugin
