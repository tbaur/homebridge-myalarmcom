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
    halfOpenMax: number;
    /** Sliding window over which failures are counted, in ms. */
    failureWindowMs: number;
    /** Called on every state transition, for observability. */
    onStateChange?: (from: CircuitState, to: CircuitState) => void;
}
export declare const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig;
/** Snapshot of breaker state, for diagnostics. */
export interface CircuitBreakerStatus {
    state: CircuitState;
    failures: number;
    successes: number;
    lastFailureTime: number | null;
    isOpen: boolean;
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
    get state(): CircuitState;
    get isOpen(): boolean;
    /** Whether a request may proceed right now. */
    canRequest(): boolean;
    recordSuccess(): void;
    recordFailure(): void;
    reset(): void;
    getStatus(): CircuitBreakerStatus;
    /**
     * Run an operation under the breaker.
     *
     * @throws {CircuitBreakerError} The circuit is open.
     */
    execute<T>(operation: () => Promise<T>): Promise<T>;
}
//# sourceMappingURL=circuit-breaker.d.ts.map