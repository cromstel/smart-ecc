/**
 * ECC Plugins barrel for OpenCode.
 *
 * OpenCode discovers plugins by scanning the `plugins/` directory, independent of
 * `opencode.json`. This barrel MUST stay inert: loading it as a plugin would
 * initialize every ECC hook a second time, because OpenCode loads
 * `ecc-hooks.ts` directly (and again through the `plugins` directory alias).
 * The published package root re-exports the real plugin from `ecc-hooks.ts`, so
 * this file exists only to satisfy Node's directory-index resolution for module
 * importers.
 *
 * This mirrors the inert stub the installer writes for home-target installs
 * (`scripts/lib/install/hook-consent.js` → getDisabledOpenCodePluginContent).
 */

export default async () => ({})
