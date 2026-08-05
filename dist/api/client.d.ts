/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Typed client for the Alarm.com JSON:API surface.
 *
 * Every attempt passes through pacing and then the circuit breaker. Retry wraps
 * the whole thing, so a retried attempt is re-paced and re-checked against the
 * breaker rather than bypassing them — which is what stops retry amplifying a
 * problem. Session establishment sits outside all three: it has its own floor,
 * and counting a login as request latency made the reported percentiles
 * meaningless.
 */
import type { EventStreamToken, PartitionAction, PartitionAttributes, Resource, SensorAttributes } from '../types/alarm';
import type { Logger } from '../utils/logger';
import { CircuitBreaker, CircuitState } from './circuit-breaker';
import { RateLimiter } from './rate-limiter';
import type { SessionManager } from './session-manager';
export type { EventStreamToken, PartitionAction };
/** One timed API call outcome for diagnostics. */
export interface ApiRequestMetric {
    durationMs: number;
    isOk: boolean;
    /** False when the call never reached the network (breaker open, rate limited). */
    wasNetworked: boolean;
}
/**
 * Modifiers that may accompany an arming command.
 *
 * Only the two HomeKit can actually express. `noEntryDelay` and `silentArming`
 * were also declared here and read into the request body, but nothing could ever
 * set them — HomeKit has no vocabulary for either, so the plugin would have been
 * choosing them on the user's behalf. They are still sent as `false`, because
 * that is what the observed protocol expects, but they are no longer pretended
 * to be options.
 */
export interface PartitionCommandOptions {
    nightArming?: boolean;
    forceBypass?: boolean;
}
/** Device identifiers discovered from a system. */
export interface SystemDevices {
    partitionIds: string[];
    sensorIds: string[];
}
/** Health of the resilience layers, as reported by {@link AlarmComClient.getStatus}. */
export interface ClientStatus {
    circuitBreaker: {
        state: CircuitState;
    };
    rateLimiter: {
        remaining: number;
    };
    hasSession: boolean;
}
export interface AlarmComClientOptions {
    sessionManager: SessionManager;
    log: Logger;
    circuitBreaker?: CircuitBreaker;
    rateLimiter?: RateLimiter;
    /** Called after every request attempt, for diagnostics. */
    metrics?: (sample: ApiRequestMetric) => void;
    /** Called when the circuit breaker opens. */
    onCircuitOpen?: () => void;
    /** Called when pacing refuses a request because the wait would be too long. */
    onThrottle?: () => void;
    /** Called when a transient failure is about to be retried. */
    onRetry?: () => void;
    /** Cancels in-flight requests and pending waits when the platform shuts down. */
    signal?: AbortSignal;
}
/** Reads and commands Alarm.com devices. */
export declare class AlarmComClient {
    #private;
    constructor(options: AlarmComClientOptions);
    /** Resolve the system this account has selected. */
    getSystemId(signal?: AbortSignal): Promise<string>;
    /** List the partition and sensor IDs belonging to a system. */
    getSystemDevices(systemId: string, signal?: AbortSignal): Promise<SystemDevices>;
    /** Read the current state of the given sensors. */
    getSensors(ids: readonly string[], signal?: AbortSignal): Promise<Resource<SensorAttributes>[]>;
    /** Read the current state of the given partitions. */
    getPartitions(ids: readonly string[], signal?: AbortSignal): Promise<Resource<PartitionAttributes>[]>;
    /**
     * Send an arming command to a partition.
     *
     * Modifiers are omitted rather than sent as `false` where Alarm.com is known
     * to reject them: `nightArming` and `forceBypass` break the command outright
     * on panels that do not support them, and neither applies to a disarm.
     *
     * Not wrapped in {@link withRetry}: arming is not idempotent from the user's
     * point of view — a duplicate command can produce a second exit-delay
     * countdown. A lapsed session is still recovered once (invalidate + one
     * retry), matching read paths, so dead cookies do not fail a user command
     * that the next poll would have survived.
     */
    commandPartition(partitionId: string, action: PartitionAction, options?: PartitionCommandOptions): Promise<Resource<PartitionAttributes>>;
    /**
     * Obtain a short-lived token for the push event stream.
     *
     * This endpoint answers with a flat object rather than a JSON:API document,
     * unlike every other route on this surface.
     */
    getEventStreamToken(): Promise<EventStreamToken>;
    /** Diagnostics for the resilience layers. */
    getStatus(): ClientStatus;
}
//# sourceMappingURL=client.d.ts.map