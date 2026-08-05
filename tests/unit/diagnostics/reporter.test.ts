/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * A log that only ever reports failures cannot tell an operator whether the
 * problem is still there, so the recovered line matters as much as the degraded
 * one — and it had no test at all.
 */

import { CircuitState } from '../../../src/api/circuit-breaker'
import type { DiagnosticsReaders } from '../../../src/diagnostics/collector'
import { DiagnosticsCollector } from '../../../src/diagnostics/collector'
import { DiagnosticsReporter } from '../../../src/diagnostics/reporter'
import type { ResolvedConfig } from '../../../src/types/config'
import { createRecordingLogger, messagesAt, type RecordingLogger } from '../../helpers/logger'

const CONFIG: ResolvedConfig = {
  username: 'user@example.com',
  password: 'correct-horse-battery',
  twoFactorAuthenticationId: 'a'.repeat(64),
  pollIntervalSeconds: 60,
  authIntervalMinutes: 10,
  useEventStream: true,
  ignoredDeviceIds: new Set(),
  includeUnmonitoredSensors: false,
  debug: true,
  diagnosticsInterval: 60,
}

describe('DiagnosticsReporter', () => {
  let log: RecordingLogger
  let breakerState: CircuitState
  let readers: DiagnosticsReaders

  function createReporter(intervalMs = 60_000): DiagnosticsReporter {
    return new DiagnosticsReporter({
      collector: new DiagnosticsCollector({ pluginVersion: '0.1.0', config: CONFIG }),
      readers,
      log,
      intervalMs,
    })
  }

  beforeEach(() => {
    jest.useFakeTimers()
    log = createRecordingLogger()
    breakerState = CircuitState.CLOSED
    readers = {
      clientStatus: () => ({
        circuitBreaker: { state: breakerState },
        rateLimiter: { remaining: 60 },
        hasSession: true,
      }),
      wsStatus: () => ({
        isConnected: true,
        isConnecting: false,
        isClosed: false,
        lastEventAgeSec: 1,
        disconnectAgeSec: null,
      }),
      devices: () => ({ partitions: 1, sensors: 3, byType: { contact: 3 }, ignored: 0 }),
      pollingCadenceSec: () => 60,
      eventStreamExpected: () => true,
    }
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('does nothing at all when heartbeats are switched off', () => {
    const reporter = createReporter(0)

    reporter.start()
    jest.advanceTimersByTime(600_000)
    reporter.stop()

    expect(log.info).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })

  it('reports the boot snapshot and then heartbeats on the interval', () => {
    const reporter = createReporter()

    reporter.start()
    expect(messagesAt(log, 'info').join('\n')).toMatch(/Diagnostics start: healthy/)

    jest.advanceTimersByTime(120_000)

    expect(messagesAt(log, 'info').filter((line) => line.includes('Health: healthy'))).toHaveLength(2)
  })

  it('warns on the edge into degraded and says so plainly on the way back', () => {
    const reporter = createReporter()
    reporter.start()

    breakerState = CircuitState.OPEN
    reporter.heartbeat()

    expect(messagesAt(log, 'warn').join('\n')).toMatch(/Health degraded: degraded \[circuitBreakerOpen\]/)

    breakerState = CircuitState.CLOSED
    reporter.heartbeat()

    expect(messagesAt(log, 'info').join('\n')).toMatch(/Health recovered: healthy/)
  })

  it('reports each transition once, not on every heartbeat while degraded', () => {
    const reporter = createReporter()
    reporter.start()
    breakerState = CircuitState.OPEN

    reporter.heartbeat()
    reporter.heartbeat()
    reporter.heartbeat()

    expect(messagesAt(log, 'warn').filter((line) => line.includes('Health degraded'))).toHaveLength(1)
  })

  it('emits a shutdown snapshot, and only for a reporter that had started', () => {
    const reporter = createReporter()

    reporter.stop()
    expect(messagesAt(log, 'info').join('\n')).not.toMatch(/Diagnostics stop/)

    reporter.start()
    reporter.stop()
    expect(messagesAt(log, 'info').join('\n')).toMatch(/Diagnostics stop/)

    // Idempotent: a second stop must not print the snapshot twice.
    reporter.stop()
    expect(messagesAt(log, 'info').filter((line) => line.includes('Diagnostics stop'))).toHaveLength(1)
  })

  /** Diagnostics that can crash the thing they diagnose are worse than none. */
  it('never lets a reader failure escape to its caller', () => {
    readers.devices = () => {
      throw new Error('device gauges unavailable')
    }
    const reporter = createReporter()

    expect(() => reporter.start()).not.toThrow()
    expect(() => reporter.heartbeat()).not.toThrow()
    expect(messagesAt(log, 'debug').join('\n')).toMatch(/device gauges unavailable/)
  })

  it('keeps the structured payload off the log when debug is disabled', () => {
    log = createRecordingLogger(false)
    const reporter = createReporter()

    reporter.start()

    expect(log.debug).not.toHaveBeenCalled()
    expect(messagesAt(log, 'info').join('\n')).toMatch(/Diagnostics start/)
  })
})
