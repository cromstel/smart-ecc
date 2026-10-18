/**
 * ECC Plugin for OpenCode
 *
 * This package provides the published ECC OpenCode plugin module:
 * - Plugin hooks (auto-format, TypeScript check, console.log warning, env injection, etc.)
 * - Custom tools (run-tests, check-coverage, security-audit, format-code, lint-check, git-summary)
 * - Bundled reference config/assets for the wider ECC OpenCode setup
 *
 * Usage:
 *
 * Option 1: Install via npm
 * ```bash
 * npm install ecc-universal
 * ```
 *
 * Then add to your opencode.json:
 * ```json
 * {
 *   "plugin": ["ecc-universal"]
 * }
 * ```
 *
 * That enables the published plugin module only. For ECC commands, agents,
 * prompts, and instructions, use this repository's `.opencode/opencode.json`
 * as a base or copy the bundled `.opencode/` assets into your project.
 *
 * Option 2: Clone and use directly
 * ```bash
 * git clone https://github.com/affaan-m/ECC
 * cd ECC
 * opencode
 * ```
 *
 * @packageDocumentation
 */

// Export the main plugin.
// The default is the dual-support entrypoint: a V1 `server()` plugin function
// plus the V2 `id` and `setup(ctx)` pair (see plugins/ecc-hooks.ts). Only the
// default is re-exported so the published module exposes a single entrypoint.
//
// The plugin is re-exported directly from `plugins/ecc-hooks.ts`. `plugins/index.ts`
// is an inert barrel: OpenCode auto-discovers every `plugins/*.ts`, so a real
// barrel would register every hook a second time.
export { default } from "./plugins/ecc-hooks.ts"
