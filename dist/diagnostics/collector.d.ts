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
import type { ResolvedConfig } from '../types/config';
import type { DiagnosticsSnapshot } from './types';
/** Subset of `client.getStatus()` the collector relies on. */
export interface ClientStatusLike {
    circuitBreaker: {
        state: string;
    };
    rateLimiter: {
        remaining: number;
    };
    hasSession: boolean;
}
/** Subset of event-stream status the collector relies on. */
export interface WebSocketStatusLike {
    isConnected: boolean;
    isConnecting: boolean;
    isClosed: boolean;
    lastEventAgeSec: number | null;
}
/** Absolute device gauges, computed by the platform from its accessories. */
export interface DeviceGauges {
    partitions: number;
    sensors: number;
    byType: Record<string, number>;
    ignored: number;
}
/**
 * Accessors the collector calls to read live in-memory state. All are synchronous
 * and must never block on the network.
 */
export interface DiagnosticsReaders {
    clientStatus: () => ClientStatusLike;
    wsStatus: () => WebSocketStatusLike | null;
    devices: () => DeviceGauges;
    pollingCadenceSec: () => number;
    /** When false, a down WebSocket is not a degradation reason (polling only). */
    eventStreamExpected: () => boolean;
}
interface CollectorOptions {
    pluginVersion: string;
    config: ResolvedConfig;
    /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
    now?: () => number;
}
/** Health classification result. */
export interface HealthRollup {
    health: 'healthy' | 'degraded';
    reasons: string[];
}
/** Accumulates diagnostics counters and renders heartbeat/snapshot reports. */
export declare class DiagnosticsCollector {
    #private;
    constructor(options: CollectorOptions);
    /**
     * Record a single API request outcome and its wall-clock duration.
     *
     * Latency is only sampled when a network fetch was actually attempted
     * (`networked`), so instant pre-flight rejections (breaker open, rate
     * limited) do not skew percentiles.
     */
    apiRequest(latencyMs: number, ok: boolean, networked?: boolean): void;
    /** Record the result of a polling cycle. */
    pollCycle(ok: number, failed: number, durationMs: number): void;
    /** Record a WebSocket reconnection (live channel recovered). */
    wsReconnect(): void;
    /** Record a circuit-breaker trip (transition into the open state). */
    breakerTrip(): void;
    /** Record a request rejected by the client-side rate limiter. */
    throttle(): void;
    /** Record a successful Alarm.com sign-in. */
    sessionLogin(): void;
    /** Record a HomeKit-originated arming command. */
    command(): void;
    /** Record a device state change that did not originate from HomeKit. */
    externalChange(): void;
    /** Record a retry attempt. */
    retry(): void;
    /**
     * Nearest-rank percentile (0..100) over the bounded recent-latency window.
     * Returns 0 when no samples are available.
     */
    percentile(p: number): number;
    /**
     * Classify current health from live readers.
     *
     * Degraded when the circuit breaker is open, the expected event stream has
     * been down longer than the threshold, or the recent API error rate is high.
     */
    rollup(readers: DiagnosticsReaders): HealthRollup;
    /**
     * Build a heartbeat report: counters are deltas since the previous heartbeat
     * (the marker is then advanced) and everything else is an absolute gauge.
     */
    buildHeartbeat(readers: DiagnosticsReaders): DiagnosticsSnapshot;
    /**
     * Build a session-cumulative snapshot (no marker advance), including the
     * redacted config echo. Used for boot/shutdown reports.
     */
    snapshot(msg: string, readers: DiagnosticsReaders): DiagnosticsSnapshot;
}
export {};
//# sourceMappingURL=collector.d.ts.map