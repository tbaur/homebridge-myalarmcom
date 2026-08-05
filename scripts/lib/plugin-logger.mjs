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
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stdout } from 'node:process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** The compiled plugin directory these scripts load the real client from. */
export const DIST_DIR = join(here, '..', '..', 'dist')

const require = createRequire(import.meta.url)

/** Exit with an actionable message when the plugin has not been built. */
export function requireBuild() {
  if (!existsSync(join(DIST_DIR, 'index.js'))) {
    stdout.write('dist/ is missing. Run "npm run build" first.\n')
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
