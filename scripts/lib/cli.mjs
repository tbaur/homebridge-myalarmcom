/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Shared argument handling for the development scripts.
 *
 * These scripts are run by an operator whose plugin has already stopped
 * working, which is the worst possible moment to discover that `--help` drops
 * you into a hidden password prompt or that a mistyped flag was silently
 * ignored.
 */

import { argv, exit, stdout } from 'node:process'

/**
 * Print usage and exit when `--help` or `-h` is present.
 *
 * @param {string} usage Text to print, already formatted.
 */
export function handleHelp(usage) {
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(`${usage.trimEnd()}\n`)
    exit(0)
  }
}

/** Whether a bare flag was passed. */
export function hasFlag(name) {
  return argv.includes(name)
}

/**
 * The value following a flag, or `undefined` when the flag is absent.
 *
 * A value beginning with `-` is treated as the next flag rather than as this
 * one's value — unless it parses as a number, so `--minutes -5` reaches the
 * range check that can explain the real problem instead of being reported as a
 * missing value.
 *
 * @param name The flag, including its leading dashes.
 * @param example What a valid value looks like, for the error message.
 * @throws {Error} The flag was given without a value.
 */
export function readFlag(name, example = '60') {
  const index = argv.indexOf(name)
  if (index === -1) {
    return undefined
  }

  const value = argv[index + 1]
  const isNextFlag = value !== undefined
    && value.startsWith('-')
    && !Number.isFinite(Number(value))

  if (value === undefined || isNextFlag) {
    throw new Error(`${name} needs a value, for example "${name} ${example}".`)
  }
  return value
}

/**
 * A numeric flag, validated rather than coerced.
 *
 * `Number('abc')` is `NaN`, and every `NaN > 0` test is false, so an unvalidated
 * numeric flag silently skipped the phase it was meant to configure.
 *
 * @throws {Error} The value is present but not a number in range.
 */
export function readNumericFlag(name, { fallback, min = 0, max = Number.MAX_SAFE_INTEGER }) {
  const raw = readFlag(name)
  if (raw === undefined) {
    return fallback
  }

  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}; got "${raw}".`)
  }
  return value
}
