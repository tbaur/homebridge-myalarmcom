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

import { CircuitState } from '../api/circuit-breaker'
import type { ClientStatus } from '../api/client'
import type { EventStreamStatus } from '../api/event-stream'
import { MS_PER_SECOND } from '../settings'
import type { SensorServiceKind } from '../types/alarm'
import type { ResolvedConfig } from '../types/config'
import type { DiagnosticsChannel, DiagnosticsSnapshot, WebSocketState } from './types'

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

/**
 * Status shapes the collector reads.
 *
 * Aliases of the producers' own types rather than re-declarations: the two
 * previously identical copies could drift apart without anything noticing.
 */
export type ClientStatusLike = ClientStatus
export type WebSocketStatusLike = EventStreamStatus

/** Absolute device gauges, computed by the platform from its accessories. */
export interface DeviceGauges {
  partitions: number
  sensors: number
  byType: Partial<Record<SensorServiceKind, number>>
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

/** One set of reader values, taken once and shared across a report. */
interface ReaderSnapshot {
  status: ClientStatus
  ws: EventStreamStatus | null
  isEventStreamExpected: boolean
}

/** Read every reader exactly once. */
function readSnapshot(readers: DiagnosticsReaders): ReaderSnapshot {
  return {
    status: readers.clientStatus(),
    ws: readers.wsStatus(),
    isEventStreamExpected: readers.eventStreamExpected(),
  }
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
  apiRequest(latencyMs: number, isOk: boolean, wasNetworked = true): void {
    this.#apiRequests++
    if (!isOk) {
      this.#apiErrors++
    }

    if (wasNetworked && Number.isFinite(latencyMs) && latencyMs >= 0) {
      this.#latencies.push(latencyMs)
      if (this.#latencies.length > LATENCY_WINDOW) {
        this.#latencies.shift()
      }
    }

    this.#recentOutcomes.push(isOk)
    if (this.#recentOutcomes.length > OUTCOME_WINDOW) {
      this.#recentOutcomes.shift()
    }
  }

  /** Record the result of a polling cycle. */
  pollCycle(okCount: number, failedCount: number, durationMs: number): void {
    this.#pollOk += okCount
    this.#pollFailed += failedCount
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
   * Nearest-rank percentiles (0..100) over the bounded recent-latency window,
   * from one sort. Zero for every rank when there are no samples.
   *
   * Batched because every report wants both p50 and p95, and computing them
   * separately copied and sorted the whole window twice for no benefit. There
   * was also a public single-rank wrapper around this, used by nothing but its
   * own tests — so four tests asserted through an API the plugin did not use.
   */
  #percentiles(ranks: readonly number[]): number[] {
    if (this.#latencies.length === 0) {
      return ranks.map(() => 0)
    }

    const sorted = [...this.#latencies].sort((a, b) => a - b)

    return ranks.map((rank) => {
      const clamped = Math.min(100, Math.max(0, rank))
      const position = Math.ceil((clamped / 100) * sorted.length)
      const index = Math.min(sorted.length - 1, Math.max(0, position - 1))
      return sorted[index] ?? 0
    })
  }

  /**
   * Classify current health from live readers.
   *
   * Degraded when the circuit breaker is open, the expected event stream has
   * been down longer than the threshold, or the recent API error rate is high.
   */
  rollup(readers: DiagnosticsReaders, prefetched?: ReaderSnapshot): HealthRollup {
    const reasons: string[] = []
    // Readers are cheap but not free: `clientStatus()` builds both the breaker
    // and pacing snapshots, and both prune their timestamp arrays as a side
    // effect. `#buildReport` already has these, so it passes them in rather than
    // making every report do two full status builds.
    const { status, ws, isEventStreamExpected } = prefetched ?? readSnapshot(readers)

    if (status.circuitBreaker.state === CircuitState.OPEN) {
      reasons.push('circuitBreakerOpen')
    }

    if (isEventStreamExpected && ws !== null) {
      // Disconnect duration, not last-event age: a quiet house must not look
      // like an outage the moment the socket blips for a second.
      const disconnectAgeSec = ws.disconnectAgeSec
      if (
        !ws.isConnected
        && disconnectAgeSec !== null
        && disconnectAgeSec > WS_DOWN_THRESHOLD_SEC
      ) {
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
  snapshot(msg: DiagnosticsChannel, readers: DiagnosticsReaders): DiagnosticsSnapshot {
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
    return Math.round((this.#now() - this.#startedAtMs) / MS_PER_SECOND)
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
    msg: DiagnosticsChannel,
    counters: CounterValues,
    readers: DiagnosticsReaders,
  ): DiagnosticsSnapshot {
    const snapshot = readSnapshot(readers)
    const { status, ws, isEventStreamExpected } = snapshot
    const { health, reasons } = this.rollup(readers, snapshot)
    const [p50Ms, p95Ms] = this.#percentiles([50, 95])

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
        state: webSocketState(ws, isEventStreamExpected),
        lastEventAgeSec: ws ? ws.lastEventAgeSec : null,
        reconnects: counters.reconnects,
      },
      circuitBreaker: {
        state: status.circuitBreaker.state,
        lastTripAt: this.#lastTripAt === null ? null : new Date(this.#lastTripAt).toISOString(),
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
        p50Ms: p50Ms ?? 0,
        p95Ms: p95Ms ?? 0,
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

function webSocketState(ws: WebSocketStatusLike | null, isExpected: boolean): WebSocketState {
  if (!isExpected) {
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
