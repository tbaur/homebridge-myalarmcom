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

export function createRecordingLogger(): RecordingLogger {
  return {
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
