/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Resolves the installed plugin version.
 */

/**
 * Installed plugin version, or `unknown` if it cannot be read.
 *
 * Resolved via `require` rather than a static `import`: `package.json` lives
 * outside the TypeScript `rootDir` (`src/`), so importing it would alter the
 * emitted `dist/` layout. The require resolves correctly from both the compiled
 * `dist/` output and ts-jest.
 */
function readPluginVersion(): string {
  try {
    return (require('../../package.json') as { version: string }).version || 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * The plugin's own version, resolved once at load.
 *
 * Shared rather than resolved per caller so the diagnostics report and the
 * `User-Agent` can never disagree about which build is running — which is
 * exactly what a stale hardcoded version had already caused.
 */
export const PLUGIN_VERSION = readPluginVersion()
