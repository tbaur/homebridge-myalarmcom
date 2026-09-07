/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * A logger test double. Every plugin component takes its logger by injection,
 * so assertions about what the user is told are made here rather than by
 * capturing console output.
 */

import type { Logger } from '../../src/utils/logger'

/** Log level names carrying assertable messages. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** A {@link Logger} whose calls can be inspected. */
export interface RecordingLogger extends Logger {
  debug: jest.Mock
  info: jest.Mock
  warn: jest.Mock
  error: jest.Mock
}

/**
 * @param isDebugEnabled Mirrors the real logger's flag. Components read it to
 *   skip building payloads they would otherwise discard, so a double that
 *   reported `false` would leave those branches untested.
 */
export function createRecordingLogger(isDebugEnabled = true): RecordingLogger {
  return {
    isDebugEnabled,
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }
}

/** Every first argument logged at one level, for substring matching. */
export function messagesAt(logger: RecordingLogger, level: LogLevel): string[] {
  return logger[level].mock.calls.map((call: unknown[]) => String(call[0]))
}

/**
 * Assert one logged line matches, and return it so its wording can be checked.
 *
 * Prefer this to `expect(messages.some(...)).toBe(true)`. That form passes as
 * long as a match exists anywhere and says nothing about the rest, which is how
 * a single arm came to log three lines — two of them near-duplicates — past a
 * fully green suite. Requiring exactly one match turns a repeated line into a
 * failure, and returning it means the assertion can go on to pin what it says
 * rather than stopping at the fact that something did.
 *
 * Where the whole output is short and predictable, assert the entire array
 * instead; this is for the cases where it is neither.
 */
export function expectOneMessage(messages: readonly string[], pattern: RegExp | string): string {
  const matches = messages.filter((message) =>
    typeof pattern === 'string' ? message.includes(pattern) : pattern.test(message))

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one message matching ${String(pattern)}, found ${matches.length}.\n`
      + `All messages:\n${messages.map((message) => `  ${message}`).join('\n')}`,
    )
  }

  return matches[0] as string
}
