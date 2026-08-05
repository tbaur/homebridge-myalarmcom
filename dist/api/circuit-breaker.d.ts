/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Circuit breaker for API resilience.
 *
 * Beyond the usual benefit of not hammering a service that is already failing,
 * this has a specific purpose here: Alarm.com locks accounts that generate
 * sustained failing traffic, and a locked account takes down the alarm panel's
 * own app access. Failing fast protects the user's account, not just the plugin.
 */
/** Circuit breaker states. */
export declare enum CircuitState {
    /** Normal operation; requests flow through. */
    CLOSED = "CLOSED",
    /** Tripped; requests fail immediately. */
    OPEN = "OPEN",
    /** Probing whether the service recovered. */
    HALF_OPEN = "HALF_OPEN"
}
/** Circuit breaker tuning. */
export interface CircuitBreakerConfig {
    /** Failures within the window before the circuit opens. */
    failureThreshold: number;
    /** How long to stay open before probing again, in ms. */
    resetTimeoutMs: number;
    /** Consecutive successes needed to close from half-open. */
    successesToClose: number;
    /** Concurrent probes admitted while half-open. */
    halfOpenProbes: number;
    /** Sliding window over which failures are counted, in ms. */
    failureWindowMs: number;
    /**
     * Window within which consecutive failures count as one.
     *
     * One logical request retries a few times within a couple of seconds; that is
     * one failure of one request, not three independent signals about the service.
     */
    failureCoalesceMs: number;
    /** Called on every state transition, for observability. */
    onStateChange?: (from: CircuitState, to: CircuitState) => void;
}
export declare const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig;
/**
 * Snapshot of breaker state, for diagnostics.
 *
 * Trimmed to what is consumed. It previously carried `failures`, `successes`,
 * `lastFailureTime` and `isOpen`, all computed on every diagnostics heartbeat
 * and read by nothing.
 */
export interface CircuitBreakerStatus {
    state: CircuitState;
    /** Failures inside the sliding window, one per logical request. */
    failures: number;
    /** How long until a probe is admitted, or `null` when one already would be. */
    remainingResetTimeMs: number | null;
}
/** Circuit breaker guarding calls to Alarm.com. */
export declare class CircuitBreaker {
    #private;
    constructor(config?: Partial<CircuitBreakerConfig>);
    /**
     * Chain an additional state-change listener (e.g. client logging) without
     * replacing any listener already supplied at construction.
     */
    attachOnStateChange(handler: (from: CircuitState, to: CircuitState) => void): void;
    /** Whether the breaker is currently rejecting requests outright. */
    get isOpen(): boolean;
    /** Whether a request may proceed right now. */
    canRequest(): boolean;
    /** Note that a guarded call succeeded, closing the circuit once enough have. */
    recordSuccess(): void;
    /**
     * Note that a guarded call failed, opening the circuit once enough have.
     *
     * Deduplicated within `#failureCoalesceMs`. One logical request is up to
     * `MAX_API_RETRY_ATTEMPTS` guarded calls landing within a few seconds, so
     * counting each separately meant two isolated flaky requests anywhere in the
     * window tripped a breaker configured for five failures — however many
     * hundreds of requests had succeeded in between.
     */
    recordFailure(): void;
    /** Return to the closed state and forget all recorded failures. */
    reset(): void;
    /** Snapshot of breaker state, for diagnostics. */
    getStatus(): CircuitBreakerStatus;
    /**
     * Run an operation under the breaker.
     *
     * @throws {CircuitBreakerError} The circuit is open.
     */
    execute<T>(operation: () => Promise<T>): Promise<T>;
}
//# sourceMappingURL=circuit-breaker.d.ts.map