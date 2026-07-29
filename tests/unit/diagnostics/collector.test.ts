/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import { DiagnosticsCollector } from '../../../src/diagnostics/collector'
import type { DiagnosticsReaders } from '../../../src/diagnostics/collector'
import type { ResolvedConfig } from '../../../src/types/config'

const baseConfig = (): ResolvedConfig => ({
  name: 'MyAlarmCom',
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
  breakerState: { value: string }
  ws: {
    value: {
      isConnected: boolean
      isConnecting: boolean
      isClosed: boolean
      lastEventAgeSec: number | null
    } | null
  }
  rateLimiterRemaining: { value: number }
  hasSession: { value: boolean }
  eventStreamExpected: { value: boolean }
}

const makeReaders = (): MutableReaders => {
  const breakerState = { value: 'CLOSED' }
  const ws = {
    value: {
      isConnected: true,
      isConnecting: false,
      isClosed: false,
      lastEventAgeSec: 2 as number | null,
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

    expect(collector.percentile(50)).toBe(50)
    expect(collector.percentile(95)).toBe(90)
  })

  describe('rollup', () => {
    it('is healthy when breaker is closed, stream is up, and errors are low', () => {
      const m = makeReaders()
      const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })
      expect(collector.rollup(m.readers)).toEqual({ health: 'healthy', reasons: [] })
    })

    it('degrades when the circuit breaker is open', () => {
      const m = makeReaders()
      m.breakerState.value = 'OPEN'
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
      }
      const collector = new DiagnosticsCollector({ pluginVersion: '0.1.0', config: baseConfig() })
      expect(collector.rollup(m.readers).reasons).toContain('webSocketDown')
    })

    it('does not treat a disabled event stream as degraded', () => {
      const m = makeReaders()
      m.eventStreamExpected.value = false
      m.ws.value = {
        isConnected: false,
        isConnecting: false,
        isClosed: true,
        lastEventAgeSec: 999,
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
})
