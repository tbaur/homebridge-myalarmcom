/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Logging wrapper that enforces redaction.
 *
 * Every log line the plugin emits passes through here, so redaction cannot be
 * forgotten at an individual call site. Messages are not component-prefixed:
 * Homebridge already tags lines with the plugin name (e.g. `[myalarmcom]`).
 */

import { sanitizeLogParameter, sanitizeString } from './sanitizers'

/** Somewhere log lines can be written. Homebridge's `Logging` satisfies this. */
export interface LogSink {
  debug(message: string, ...parameters: unknown[]): void
  info(message: string, ...parameters: unknown[]): void
  warn(message: string, ...parameters: unknown[]): void
  error(message: string, ...parameters: unknown[]): void
}

/** A redacting logger. */
export interface Logger extends LogSink {
  /**
   * Whether debug output is enabled.
   *
   * Exposed so callers can skip building a payload that would be discarded.
   * Dropping the `debug` call is not enough on its own: JavaScript evaluates
   * the argument before the call, so an expensive template literal is paid for
   * even when the line is never written.
   */
  readonly isDebugEnabled: boolean
}

/**
 * Wrap a log sink so messages and parameters are stripped of secrets.
 *
 * Always wrap the *raw* sink. Wrapping an already-wrapped logger runs the whole
 * pattern set twice on every line — in the polling hot path.
 *
 * @param _scope Retained for call-site documentation only (auth, events, …).
 *   Not written into the log line — Homebridge already scopes by plugin name.
 * @param isDebugEnabled When false, `debug` calls are dropped entirely rather
 *   than delegated, so verbose paths cost nothing in normal operation.
 */
export function createScopedLogger(
  base: LogSink,
  _scope: string,
  isDebugEnabled: boolean,
): Logger {
  const format = (message: string): string => sanitizeString(message)

  // Parameters are redacted too. Sanitizing only the message left the wrapper
  // claiming a guarantee it did not provide: `log.debug('cookies', header)`
  // handed the header straight to Homebridge untouched.
  const clean = (parameters: unknown[]): unknown[] => parameters.map(sanitizeLogParameter)

  return {
    isDebugEnabled,
    debug: isDebugEnabled
      ? (message, ...parameters) => base.debug(format(message), ...clean(parameters))
      : () => undefined,
    info: (message, ...parameters) => base.info(format(message), ...clean(parameters)),
    warn: (message, ...parameters) => base.warn(format(message), ...clean(parameters)),
    error: (message, ...parameters) => base.error(format(message), ...clean(parameters)),
  }
}
