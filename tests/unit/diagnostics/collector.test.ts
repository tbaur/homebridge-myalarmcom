/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import { DiagnosticsCollector } from '../../../src/diagnostics/collector'
import type { DiagnosticsReaders } from '../../../src/diagnostics/collector'
import type { ResolvedConfig } from '../../../src/types/config'
import { CircuitState } from '../../../src/api/circuit-breaker'

const baseConfig = (): ResolvedConfig => ({
  username: 'user@example.com',
  password: 'superSecretPassword',
  twoFactorAuthenticationId: 'a'.repeat(64),
  pollIntervalSeconds: 60,
  authIntervalMinutes: 10,
  useEventStream: true,
  ignoredDeviceIds: new Set(['1234567-99']),
  includeUnmonitoredSensors: false,
  debug: false,
  diagnosticsInterval: 60,
})

interface MutableReaders {
  readers: DiagnosticsReaders
  breakerState: { value: CircuitState }
  ws: {
    value: {
      isConnected: boolean
      isConnecting: boolean
      isClosed: boolean
      lastEventAgeSec: number | null
      disconnectAgeSec: number | null
    } | null
  }
  rateLimiterRemaining: { value: number }
  hasSession: { value: boolean }
  eventStreamExpected: { value: boolean }
}

const makeReaders = (): MutableReaders => {
  const breakerState = { value: CircuitState.CLOSED }
  const ws = {
    value: {
      isConnected: true,
      isConnecting: false,
      isClosed: false,
      lastEventAgeSec: 2 as number | null,
      disconnectAgeSec: null as number | null,
    },
  }
  const rateLimiterRemaining = { value: 50 }
  const hasSession = { value: true }
  const eventStreamExpected = { value: true }

  const readers: DiagnosticsReaders = {
    clientStatus: () => ({
      circuitBreaker: { state: breakerState.value },
      rateLimiter: { remaining: rateLimiterRemaining.value },
      hasSession: hasSession.value,
    }),
    wsStatus: () => ws.value,
    devices: () => ({
      partitions: 1,
      sensors: 3,
      byType: { contact: 2, motion: 1 },
      ignored: 1,
    }),
    pollingCadenceSec: () => 60,
    eventStreamExpected: () => eventStreamExpected.value,
  }

  return {
    readers,
    breakerState,
    ws,
    rateLimiterRemaining,
    hasSession,
    eventStreamExpected,
  }
}

describe('DiagnosticsCollector', () => {
  /**
   * The two time-derived fields, on a controlled clock.
   *
   * The collector declares an injectable clock "for deterministic tests" and no
   * test used it, so nothing asserted either value — and `lastTripAt` used to be
   * emitted as a raw epoch integer that an operator had to convert by hand.
   */
  describe('time-derived fields', () => {
    it('reports uptime in seconds and the last breaker trip as an ISO timestamp', () => {
      const clock = { value: Date.UTC(2026, 6, 29, 2, 0, 0) }
      const collector = new DiagnosticsCollector({
        pluginVersion: '0.1.0',
        config: baseConfig(),
        now: () => clock.value,
      })

      clock.value += 90_000
      collector.breakerTrip()
      clock.value += 30_000

      const report = collector.buildHeartbeat(makeReaders().readers)

      expect(report.lifecycle.uptimeSec).toBe(120)
      expect(report.circuitBreaker.lastTripAt).toBe('2026-07-29T02:01:30.000Z')
    })

    it('reports no trip time before the breaker has ever opened', () => {
      const collector = new DiagnosticsCollector({
        pluginVersion: '0.1.0',
        config: baseConfig(),
        now: () => 0,
      })

      expect(collector.buildHeartbeat(makeReaders().readers).circuitBreaker.lastTripAt).toBeNull()
    })
  })

  it('reports per-interval deltas and advances the marker each heartbeat', () => {
    const m = makeReaders()
    const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })

    collector.apiRequest(100, true)
    collector.apiRequest(200, false)
    collector.pollCycle(3, 1, 42)
    collector.command()
    collector.externalChange()
    collector.retry()
    collector.sessionLogin()
    collector.wsReconnect()
    collector.breakerTrip()
    collector.throttle()

    const first = collector.buildHeartbeat(m.readers)
    expect(first.api.requests).toBe(2)
    expect(first.api.errors).toBe(1)
    expect(first.polling.ok).toBe(3)
    expect(first.polling.failed).toBe(1)
    expect(first.polling.lastDurationMs).toBe(42)
    expect(first.activity.commandsSent).toBe(1)
    expect(first.activity.externalChanges).toBe(1)
    expect(first.activity.retries).toBe(1)
    expect(first.session.logins).toBe(1)
    expect(first.websocket.reconnects).toBe(1)
    expect(first.circuitBreaker.trips).toBe(1)
    expect(first.rateLimiter.throttled).toBe(1)

    const second = collector.buildHeartbeat(m.readers)
    expect(second.api.requests).toBe(0)
    expect(second.api.errors).toBe(0)
    expect(second.polling.ok).toBe(0)
    expect(second.session.logins).toBe(0)
  })

  it('includes a redacted config echo on snapshots and never credentials', () => {
    const m = makeReaders()
    const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })
    const report = collector.snapshot('diagnostics.start', m.readers)

    expect(report.config).toEqual({
      diagnosticsInterval: 60,
      pollIntervalSeconds: 60,
      authIntervalMinutes: 10,
      useEventStream: true,
      includeUnmonitoredSensors: false,
      ignoredDeviceIds: 1,
      debug: false,
    })
    expect(JSON.stringify(report)).not.toContain('superSecretPassword')
    expect(JSON.stringify(report)).not.toContain('user@example.com')
    expect(JSON.stringify(report)).not.toContain('aaaaaaaa')
  })

  it('computes latency percentiles only from networked samples', () => {
    const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })
    collector.apiRequest(10, true, true)
    collector.apiRequest(50, true, true)
    collector.apiRequest(90, true, true)
    collector.apiRequest(9999, false, false)

    expect(collector.buildHeartbeat(makeReaders().readers).api.p50Ms).toBe(50)
    expect(collector.buildHeartbeat(makeReaders().readers).api.p95Ms).toBe(90)
  })

  describe('rollup', () => {
    it('is healthy when breaker is closed, stream is up, and errors are low', () => {
      const m = makeReaders()
      const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })
      expect(collector.rollup(m.readers)).toEqual({ health: 'healthy', reasons: [] })
    })

    it('degrades when the circuit breaker is open', () => {
      const m = makeReaders()
      m.breakerState.value = CircuitState.OPEN
      const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })
      expect(collector.rollup(m.readers)).toEqual({
        health: 'degraded',
        reasons: ['circuitBreakerOpen'],
      })
    })

    it('degrades when the expected event stream has been down long enough', () => {
      const m = makeReaders()
      m.ws.value = {
        isConnected: false,
        isConnecting: false,
        isClosed: false,
        lastEventAgeSec: 120,
        disconnectAgeSec: 120,
      }
      const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })
      expect(collector.rollup(m.readers).reasons).toContain('webSocketDown')
    })

    it('does not degrade on a brief disconnect after a quiet period', () => {
      const m = makeReaders()
      m.ws.value = {
        isConnected: false,
        isConnecting: false,
        isClosed: false,
        lastEventAgeSec: 999,
        disconnectAgeSec: 1,
      }
      const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })
      expect(collector.rollup(m.readers)).toEqual({ health: 'healthy', reasons: [] })
    })

    it('does not treat a disabled event stream as degraded', () => {
      const m = makeReaders()
      m.eventStreamExpected.value = false
      m.ws.value = {
        isConnected: false,
        isConnecting: false,
        isClosed: true,
        lastEventAgeSec: 999,
        disconnectAgeSec: 999,
      }
      const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })
      expect(collector.rollup(m.readers)).toEqual({ health: 'healthy', reasons: [] })
    })

    it('degrades when the recent API error rate is high', () => {
      const m = makeReaders()
      const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })
      // 8 failures of 12 samples → 0.67, above the 0.5 threshold.
      for (let i = 0; i < 12; i++) {
        collector.apiRequest(10, i >= 8)
      }
      expect(collector.rollup(m.readers).reasons).toContain('apiErrorRateHigh')
    })
  })

  /**
   * The plugin is a daemon that runs for months. These two evictions are the
   * only thing between the collector and a slow memory leak, and nothing
   * exercised them: the tests never pushed more than a handful of samples.
   */
  describe('bounded memory', () => {
    it('keeps only the most recent latencies for percentile math', () => {
      const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })

      // 250 samples of 1ms, then 200 of 500ms: exactly enough to displace every
      // one of the cheap samples if the window is honoured.
      for (let index = 0; index < 250; index++) {
        collector.apiRequest(1, true)
      }
      for (let index = 0; index < 200; index++) {
        collector.apiRequest(500, true)
      }

      // Both percentiles report the expensive samples: if any of the 1ms samples
      // had survived the window they would be the cheap end of the distribution.
      const { p50Ms, p95Ms } = collector.buildHeartbeat(makeReaders().readers).api
      expect(p50Ms).toBe(500)
      expect(p95Ms).toBe(500)
    })

    it('judges the error rate on recent outcomes only, not the whole session', () => {
      const m = makeReaders()
      const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })

      for (let index = 0; index < 100; index++) {
        collector.apiRequest(10, false)
      }
      expect(collector.rollup(m.readers).reasons).toContain('apiErrorRateHigh')

      // 50 successes is the whole window, so the earlier failures must age out.
      for (let index = 0; index < 50; index++) {
        collector.apiRequest(10, true)
      }

      expect(collector.rollup(m.readers).reasons).not.toContain('apiErrorRateHigh')
    })
  })

  describe('the reported WebSocket state', () => {
    it.each([
      ['disabled', { isExpected: false, ws: null }],
      ['disconnected', { isExpected: true, ws: null }],
      ['closed', { isExpected: true, ws: { isConnected: false, isConnecting: false, isClosed: true, lastEventAgeSec: null, disconnectAgeSec: 5 } }],
      ['connected', { isExpected: true, ws: { isConnected: true, isConnecting: false, isClosed: false, lastEventAgeSec: 1, disconnectAgeSec: null } }],
      ['connecting', { isExpected: true, ws: { isConnected: false, isConnecting: true, isClosed: false, lastEventAgeSec: null, disconnectAgeSec: null } }],
      ['disconnected', { isExpected: true, ws: { isConnected: false, isConnecting: false, isClosed: false, lastEventAgeSec: null, disconnectAgeSec: 1 } }],
    ])('is "%s" for the matching status', (expected, { isExpected, ws }) => {
      const m = makeReaders()
      m.eventStreamExpected.value = isExpected
      m.ws.value = ws
      const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })

      expect(collector.snapshot('health', m.readers).websocket.state).toBe(expected)
    })
  })
})
