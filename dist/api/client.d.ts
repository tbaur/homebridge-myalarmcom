/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Typed client for the Alarm.com JSON:API surface.
 *
 * Every outbound call passes through pacing, then the circuit breaker, then
 * retry. That order is deliberate: pacing shapes normal traffic, the breaker
 * stops a failing service being hammered, and retry only ever runs inside those
 * two guards so it cannot amplify a problem.
 */
import type { PartitionAttributes, Resource, SensorAttributes } from '../types/alarm';
import type { Logger } from '../utils/logger';
import { CircuitBreaker } from './circuit-breaker';
import { RateLimiter } from './rate-limiter';
import type { SessionManager } from './session-manager';
/** One timed API call outcome for diagnostics. */
export interface ApiRequestMetric {
    durationMs: number;
    ok: boolean;
    /** False when the call never reached the network (breaker open, rate limited). */
    networked: boolean;
}
/** Arming commands Alarm.com accepts on a partition. */
export type PartitionAction = 'armStay' | 'armAway' | 'disarm';
/** Modifiers that may accompany an arming command. */
export interface PartitionCommandOptions {
    noEntryDelay?: boolean;
    silentArming?: boolean;
    nightArming?: boolean;
    forceBypass?: boolean;
}
/** Device identifiers discovered from a system. */
export interface SystemDevices {
    partitionIds: string[];
    sensorIds: string[];
}
/** Credentials for the push event stream. */
export interface EventStreamToken {
    token: string;
    /** Endpoint reported by Alarm.com, when it supplies one. */
    endpoint?: string;
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
}
/** Split a list into chunks no larger than the API will accept. */
export declare function chunkIds(ids: readonly string[], size?: number): string[][];
/** Reads and commands Alarm.com devices. */
export declare class AlarmComClient {
    #private;
    constructor(options: AlarmComClientOptions);
    /** Resolve the system this account has selected. */
    getSystemId(): Promise<string>;
    /** List the partition and sensor IDs belonging to a system. */
    getSystemDevices(systemId: string): Promise<SystemDevices>;
    getSensors(ids: readonly string[]): Promise<Resource<SensorAttributes>[]>;
    getPartitions(ids: readonly string[]): Promise<Resource<PartitionAttributes>[]>;
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
    getStatus(): {
        circuitBreaker: {
            state: string;
        };
        rateLimiter: {
            remaining: number;
        };
        hasSession: boolean;
    };
}
//# sourceMappingURL=client.d.ts.map