/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Redacting terminal logger for scripts that drive `dist/`.
 *
 * The plugin's "every log line is redacted" guarantee is a property of
 * `createScopedLogger`, not of the components themselves: they interpolate
 * values that are only safe because a sanitizing logger sits downstream. A
 * script that hands a plain stdout logger to `SessionManager`, `AlarmComClient`,
 * or `EventStream` silently opts out of that guarantee — and the concrete leak
 * is real, because `ws` reports a malformed endpoint by throwing
 * `SyntaxError: Invalid URL: <the whole url, token and all>`.
 */

import { createRequire } from 'node:module'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stdout } from 'node:process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** The compiled plugin directory these scripts load the real client from. */
export const DIST_DIR = join(here, '..', '..', 'dist')

const SRC_DIR = join(here, '..', '..', 'src')

const require = createRequire(import.meta.url)

/**
 * Most recent modification time anywhere under a directory, in ms.
 *
 * @param {string} dir Directory to walk.
 * @returns {number} Newest mtime found, or 0 for an empty tree.
 */
function newestModifiedMs(dir) {
  let newest = 0

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    const modified = entry.isDirectory() ? newestModifiedMs(path) : statSync(path).mtimeMs
    if (modified > newest) {
      newest = modified
    }
  }

  return newest
}

/**
 * Exit with an actionable message unless `dist/` is present and current.
 *
 * Staleness is fatal rather than a warning because these scripts exist to check
 * the code that ships. A build predating the source it was made from verifies
 * the previous release while appearing to verify the fix in front of you, and
 * nothing in the output would say so.
 */
export function requireBuild() {
  if (!existsSync(join(DIST_DIR, 'index.js'))) {
    stdout.write('dist/ is missing. Run "npm run build" first.\n')
    process.exit(1)
  }

  if (newestModifiedMs(SRC_DIR) > newestModifiedMs(DIST_DIR)) {
    stdout.write('dist/ is older than src/, so this would check the previous build.\n')
    stdout.write('Run "npm run build" first.\n')
    process.exit(1)
  }
}

/**
 * A logger that writes to the terminal with the plugin's own redaction applied.
 *
 * @param {string} scope Component label, as the plugin uses internally.
 * @param {boolean} isVerbose Whether debug lines are written at all.
 */
export function createTerminalLogger(scope, isVerbose = false) {
  const { createScopedLogger } = require(join(DIST_DIR, 'utils/logger.js'))

  const sink = {
    debug: (message) => stdout.write(`  · ${message}\n`),
    info: (message) => stdout.write(`  · ${message}\n`),
    warn: (message) => stdout.write(`  ! ${message}\n`),
    error: (message) => stdout.write(`  ✗ ${message}\n`),
  }

  return createScopedLogger(sink, scope, isVerbose)
}
