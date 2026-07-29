/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Opt-in diagnostics collector for health/activity metrics.
 *
 * One collector is owned per platform instance. It accumulates cumulative
 * counters and a bounded latency window, and turns them into:
 *   - `buildHeartbeat()` — per-interval counter deltas + absolute gauges
 *   - `snapshot()`       — session cumulative totals + redacted config echo
 *   - `rollup()`         — `{ health, reasons[] }` health classification
 *
 * It only ever reads in-memory state via the supplied `readers`; it never
 * performs any network I/O.
 */

import type { ResolvedConfig } from '../types/config'
import type { DiagnosticsSnapshot } from './types'

/** Maximum number of recent request latencies retained for percentile math. */
const LATENCY_WINDOW = 200

/** Recent request outcomes retained for the rollup error-rate calculation. */
const OUTCOME_WINDOW = 50

/** Minimum recent requests before the API error rate can mark health degraded. */
const API_ERROR_MIN_SAMPLES = 10

/** Recent error rate (0..1) above which health is considered degraded. */
const API_ERROR_RATE_THRESHOLD = 0.5

/** Seconds the WebSocket may stay disconnected before health is degraded. */
const WS_DOWN_THRESHOLD_SEC = 60

/** Subset of `client.getStatus()` the collector relies on. */
export interface ClientStatusLike {
  circuitBreaker: { state: string }
  rateLimiter: { remaining: number }
  hasSession: boolean
}

/** Subset of event-stream status the collector relies on. */
export interface WebSocketStatusLike {
  isConnected: boolean
  isConnecting: boolean
  isClosed: boolean
  lastEventAgeSec: number | null
}

/** Absolute device gauges, computed by the platform from its accessories. */
export interface DeviceGauges {
  partitions: number
  sensors: number
  byType: Record<string, number>
  ignored: number
}

/**
 * Accessors the collector calls to read live in-memory state. All are synchronous
 * and must never block on the network.
 */
export interface DiagnosticsReaders {
  clientStatus: () => ClientStatusLike
  wsStatus: () => WebSocketStatusLike | null
  devices: () => DeviceGauges
  pollingCadenceSec: () => number
  /** When false, a down WebSocket is not a degradation reason (polling only). */
  eventStreamExpected: () => boolean
}

interface CollectorOptions {
  pluginVersion: string
  config: ResolvedConfig
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number
}

interface CounterSnapshot {
  apiRequests: number
  apiErrors: number
  pollOk: number
  pollFailed: number
  wsReconnects: number
  breakerTrips: number
  throttles: number
  sessionLogins: number
  commandsSent: number
  externalChanges: number
  retries: number
}

/** Health classification result. */
export interface HealthRollup {
  health: 'healthy' | 'degraded'
  reasons: string[]
}

/** Accumulates diagnostics counters and renders heartbeat/snapshot reports. */
export class DiagnosticsCollector {
  readonly #now: () => number
  readonly #startedAtMs: number
  readonly #pluginVersion: string
  readonly #configEcho: Record<string, unknown>

  #apiRequests = 0
  #apiErrors = 0
  #pollOk = 0
  #pollFailed = 0
  #wsReconnects = 0
  #breakerTrips = 0
  #throttles = 0
  #sessionLogins = 0
  #commandsSent = 0
  #externalChanges = 0
  #retries = 0

  #lastTripAt: number | null = null
  #lastPollDurationMs: number | null = null

  readonly #latencies: number[] = []
  readonly #recentOutcomes: boolean[] = []

  #marker: CounterSnapshot

  constructor(options: CollectorOptions) {
    this.#now = options.now ?? Date.now
    this.#startedAtMs = this.#now()
    this.#pluginVersion = options.pluginVersion
    this.#configEcho = redactConfig(options.config)
    this.#marker = this.#captureCounters()
  }

  /**
   * Record a single API request outcome and its wall-clock duration.
   *
   * Latency is only sampled when a network fetch was actually attempted
   * (`networked`), so instant pre-flight rejections (breaker open, rate
   * limited) do not skew percentiles.
   */
  apiRequest(latencyMs: number, ok: boolean, networked = true): void {
    this.#apiRequests++
    if (!ok) {
      this.#apiErrors++
    }

    if (networked && Number.isFinite(latencyMs) && latencyMs >= 0) {
      this.#latencies.push(latencyMs)
      if (this.#latencies.length > LATENCY_WINDOW) {
        this.#latencies.shift()
      }
    }

    this.#recentOutcomes.push(ok)
    if (this.#recentOutcomes.length > OUTCOME_WINDOW) {
      this.#recentOutcomes.shift()
    }
  }

  /** Record the result of a polling cycle. */
  pollCycle(ok: number, failed: number, durationMs: number): void {
    this.#pollOk += ok
    this.#pollFailed += failed
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      this.#lastPollDurationMs = durationMs
    }
  }

  /** Record a WebSocket reconnection (live channel recovered). */
  wsReconnect(): void {
    this.#wsReconnects++
  }

  /** Record a circuit-breaker trip (transition into the open state). */
  breakerTrip(): void {
    this.#breakerTrips++
    this.#lastTripAt = this.#now()
  }

  /** Record a request rejected by the client-side rate limiter. */
  throttle(): void {
    this.#throttles++
  }

  /** Record a successful Alarm.com sign-in. */
  sessionLogin(): void {
    this.#sessionLogins++
  }

  /** Record a HomeKit-originated arming command. */
  command(): void {
    this.#commandsSent++
  }

  /** Record a device state change that did not originate from HomeKit. */
  externalChange(): void {
    this.#externalChanges++
  }

  /** Record a retry attempt. */
  retry(): void {
    this.#retries++
  }

  /**
   * Nearest-rank percentile (0..100) over the bounded recent-latency window.
   * Returns 0 when no samples are available.
   */
  percentile(p: number): number {
    if (this.#latencies.length === 0) {
      return 0
    }
    const sorted = [...this.#latencies].sort((a, b) => a - b)
    const clamped = Math.min(100, Math.max(0, p))
    const rank = Math.ceil((clamped / 100) * sorted.length)
    const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))
    return sorted[index]
  }

  /**
   * Classify current health from live readers.
   *
   * Degraded when the circuit breaker is open, the expected event stream has
   * been down longer than the threshold, or the recent API error rate is high.
   */
  rollup(readers: DiagnosticsReaders): HealthRollup {
    const reasons: string[] = []

    if (readers.clientStatus().circuitBreaker.state === 'OPEN') {
      reasons.push('circuitBreakerOpen')
    }

    const ws = readers.wsStatus()
    if (readers.eventStreamExpected() && ws !== null) {
      const wsAgeSec = ws.lastEventAgeSec ?? this.#uptimeSec()
      if (!ws.isConnected && wsAgeSec > WS_DOWN_THRESHOLD_SEC) {
        reasons.push('webSocketDown')
      }
    }

    const total = this.#recentOutcomes.length
    if (total >= API_ERROR_MIN_SAMPLES) {
      const errors = this.#recentOutcomes.filter((ok) => !ok).length
      if (errors / total > API_ERROR_RATE_THRESHOLD) {
        reasons.push('apiErrorRateHigh')
      }
    }

    return {
      health: reasons.length > 0 ? 'degraded' : 'healthy',
      reasons,
    }
  }

  /**
   * Build a heartbeat report: counters are deltas since the previous heartbeat
   * (the marker is then advanced) and everything else is an absolute gauge.
   */
  buildHeartbeat(readers: DiagnosticsReaders): DiagnosticsSnapshot {
    const current = this.#captureCounters()

    const counters: CounterValues = {
      reconnects: current.wsReconnects - this.#marker.wsReconnects,
      trips: current.breakerTrips - this.#marker.breakerTrips,
      throttled: current.throttles - this.#marker.throttles,
      logins: current.sessionLogins - this.#marker.sessionLogins,
      pollOk: current.pollOk - this.#marker.pollOk,
      pollFailed: current.pollFailed - this.#marker.pollFailed,
      requests: current.apiRequests - this.#marker.apiRequests,
      errors: current.apiErrors - this.#marker.apiErrors,
      commandsSent: current.commandsSent - this.#marker.commandsSent,
      externalChanges: current.externalChanges - this.#marker.externalChanges,
      retries: current.retries - this.#marker.retries,
    }

    const report = this.#buildReport('health', counters, readers)
    this.#marker = current
    return report
  }

  /**
   * Build a session-cumulative snapshot (no marker advance), including the
   * redacted config echo. Used for boot/shutdown reports.
   */
  snapshot(msg: string, readers: DiagnosticsReaders): DiagnosticsSnapshot {
    const counters: CounterValues = {
      reconnects: this.#wsReconnects,
      trips: this.#breakerTrips,
      throttled: this.#throttles,
      logins: this.#sessionLogins,
      pollOk: this.#pollOk,
      pollFailed: this.#pollFailed,
      requests: this.#apiRequests,
      errors: this.#apiErrors,
      commandsSent: this.#commandsSent,
      externalChanges: this.#externalChanges,
      retries: this.#retries,
    }

    const report = this.#buildReport(msg, counters, readers)
    report.config = { ...this.#configEcho }
    return report
  }

  #uptimeSec(): number {
    return Math.round((this.#now() - this.#startedAtMs) / 1000)
  }

  #captureCounters(): CounterSnapshot {
    return {
      apiRequests: this.#apiRequests,
      apiErrors: this.#apiErrors,
      pollOk: this.#pollOk,
      pollFailed: this.#pollFailed,
      wsReconnects: this.#wsReconnects,
      breakerTrips: this.#breakerTrips,
      throttles: this.#throttles,
      sessionLogins: this.#sessionLogins,
      commandsSent: this.#commandsSent,
      externalChanges: this.#externalChanges,
      retries: this.#retries,
    }
  }

  #buildReport(
    msg: string,
    counters: CounterValues,
    readers: DiagnosticsReaders,
  ): DiagnosticsSnapshot {
    const status = readers.clientStatus()
    const ws = readers.wsStatus()
    const { health, reasons } = this.rollup(readers)

    return {
      msg,
      lifecycle: {
        health,
        reasons,
        uptimeSec: this.#uptimeSec(),
        pluginVersion: this.#pluginVersion,
      },
      devices: readers.devices(),
      websocket: {
        state: webSocketState(ws, readers.eventStreamExpected()),
        lastEventAgeSec: ws ? ws.lastEventAgeSec : null,
        reconnects: counters.reconnects,
      },
      circuitBreaker: {
        state: status.circuitBreaker.state,
        lastTripAt: this.#lastTripAt,
        trips: counters.trips,
      },
      rateLimiter: {
        available: status.rateLimiter.remaining,
        throttled: counters.throttled,
      },
      polling: {
        cadenceSec: readers.pollingCadenceSec(),
        lastDurationMs: this.#lastPollDurationMs,
        ok: counters.pollOk,
        failed: counters.pollFailed,
      },
      session: {
        hasSession: status.hasSession,
        logins: counters.logins,
      },
      api: {
        p50Ms: this.percentile(50),
        p95Ms: this.percentile(95),
        requests: counters.requests,
        errors: counters.errors,
      },
      activity: {
        commandsSent: counters.commandsSent,
        externalChanges: counters.externalChanges,
        retries: counters.retries,
      },
    }
  }
}

interface CounterValues {
  reconnects: number
  trips: number
  throttled: number
  logins: number
  pollOk: number
  pollFailed: number
  requests: number
  errors: number
  commandsSent: number
  externalChanges: number
  retries: number
}

function webSocketState(ws: WebSocketStatusLike | null, expected: boolean): string {
  if (!expected) {
    return 'disabled'
  }
  if (!ws) {
    return 'disconnected'
  }
  if (ws.isClosed) {
    return 'closed'
  }
  if (ws.isConnected) {
    return 'connected'
  }
  if (ws.isConnecting) {
    return 'connecting'
  }
  return 'disconnected'
}

/**
 * Build a redacted echo of the plugin config for snapshots.
 *
 * Credentials and the two-factor cookie are never included; the ignored-device
 * list is reduced to a count so the echo stays free of device identifiers.
 */
function redactConfig(config: ResolvedConfig): Record<string, unknown> {
  return {
    diagnosticsInterval: config.diagnosticsInterval,
    pollIntervalSeconds: config.pollIntervalSeconds,
    authIntervalMinutes: config.authIntervalMinutes,
    useEventStream: config.useEventStream,
    includeUnmonitoredSensors: config.includeUnmonitoredSensors,
    ignoredDeviceIds: config.ignoredDeviceIds.size,
    debug: config.debug,
  }
}
