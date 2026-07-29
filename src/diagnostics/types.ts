/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Diagnostics report shapes for health/activity logging.
 */

/** A single heartbeat or boot/shutdown diagnostics report. */
export interface DiagnosticsSnapshot {
  /** Channel identifier, e.g. `health`, `diagnostics.start`, `diagnostics.stop`. */
  msg: string
  lifecycle: {
    health: 'healthy' | 'degraded'
    reasons: string[]
    uptimeSec: number
    pluginVersion: string
  }
  devices: {
    /** Partitions published to HomeKit. */
    partitions: number
    /** Sensors published to HomeKit. */
    sensors: number
    /** Sensor counts by HomeKit kind (`contact`, `motion`, `smoke`). */
    byType: Record<string, number>
    /** Devices skipped via `ignoredDeviceIds`. */
    ignored: number
  }
  websocket: {
    state: string
    lastEventAgeSec: number | null
    reconnects: number
  }
  circuitBreaker: {
    state: string
    lastTripAt: number | null
    trips: number
  }
  rateLimiter: {
    available: number
    throttled: number
  }
  polling: {
    cadenceSec: number
    lastDurationMs: number | null
    ok: number
    failed: number
  }
  session: {
    /** Whether a live session is currently held. */
    hasSession: boolean
    /** Successful (re)authentications in this interval or session. */
    logins: number
  }
  api: {
    p50Ms: number
    p95Ms: number
    requests: number
    errors: number
  }
  activity: {
    commandsSent: number
    externalChanges: number
    retries: number
  }
  /** Redacted config echo, present only on boot/shutdown snapshots. */
  config?: Record<string, unknown>
}
