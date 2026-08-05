"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CircuitBreaker = exports.DEFAULT_CIRCUIT_BREAKER_CONFIG = exports.CircuitState = void 0;
const errors_1 = require("../errors");
const settings_1 = require("../settings");
/** Circuit breaker states. */
var CircuitState;
(function (CircuitState) {
    /** Normal operation; requests flow through. */
    CircuitState["CLOSED"] = "CLOSED";
    /** Tripped; requests fail immediately. */
    CircuitState["OPEN"] = "OPEN";
    /** Probing whether the service recovered. */
    CircuitState["HALF_OPEN"] = "HALF_OPEN";
})(CircuitState || (exports.CircuitState = CircuitState = {}));
exports.DEFAULT_CIRCUIT_BREAKER_CONFIG = {
    failureThreshold: 5,
    resetTimeoutMs: 30 * settings_1.MS_PER_SECOND,
    successesToClose: 3,
    halfOpenProbes: 3,
    /**
     * Deliberately several poll intervals wide.
     *
     * A poll cycle contributes one coalesced failure per failing request. With a
     * window equal to the default 60-second poll interval, a cycle's failures
     * always aged out before the next tick, so the breaker could never reach its
     * threshold and a total Alarm.com outage produced no `CLOSED -> OPEN` warning
     * at all — the one line a polling-only deployment would otherwise see.
     */
    failureWindowMs: 5 * settings_1.MS_PER_MINUTE,
    /**
     * Comfortably longer than one request's full retry budget.
     *
     * `MAX_API_RETRY_ATTEMPTS` attempts with jittered backoff from 1s, plus the
     * 1s pacing gap between them, fits well inside this.
     */
    failureCoalesceMs: 15 * settings_1.MS_PER_SECOND,
};
/** Circuit breaker guarding calls to Alarm.com. */
class CircuitBreaker {
    #failureThreshold;
    #resetTimeoutMs;
    #successesToClose;
    #halfOpenProbes;
    #failureWindowMs;
    #failureCoalesceMs;
    #onStateChange;
    #state = CircuitState.CLOSED;
    #successes = 0;
    #lastFailureTime = null;
    #halfOpenRequests = 0;
    #failureTimestamps = [];
    constructor(config = {}) {
        const merged = { ...exports.DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config };
        this.#failureThreshold = merged.failureThreshold;
        this.#resetTimeoutMs = merged.resetTimeoutMs;
        this.#successesToClose = merged.successesToClose;
        this.#halfOpenProbes = merged.halfOpenProbes;
        this.#failureWindowMs = merged.failureWindowMs;
        this.#failureCoalesceMs = merged.failureCoalesceMs;
        this.#onStateChange = merged.onStateChange;
    }
    /**
     * Chain an additional state-change listener (e.g. client logging) without
     * replacing any listener already supplied at construction.
     */
    attachOnStateChange(handler) {
        const previous = this.#onStateChange;
        this.#onStateChange = (from, to) => {
            previous?.(from, to);
            handler(from, to);
        };
    }
    /** Whether the breaker is currently rejecting requests outright. */
    get isOpen() {
        return this.#state === CircuitState.OPEN;
    }
    /** Transition state, notifying observers only on an actual change. */
    #transitionTo(next) {
        if (this.#state === next) {
            return;
        }
        const previous = this.#state;
        this.#state = next;
        this.#onStateChange?.(previous, next);
    }
    /** Drop failures that have aged out of the sliding window. */
    #pruneFailures() {
        const cutoff = Date.now() - this.#failureWindowMs;
        this.#failureTimestamps = this.#failureTimestamps.filter((ts) => ts > cutoff);
    }
    /** Whether a request may proceed right now. */
    canRequest() {
        if (this.#state === CircuitState.CLOSED) {
            return true;
        }
        if (this.#state === CircuitState.OPEN) {
            const isCooldownElapsed = this.#lastFailureTime !== null
                && Date.now() - this.#lastFailureTime >= this.#resetTimeoutMs;
            if (isCooldownElapsed) {
                this.#halfOpenRequests = 0;
                this.#successes = 0;
                this.#transitionTo(CircuitState.HALF_OPEN);
                return true;
            }
            return false;
        }
        return this.#halfOpenRequests < this.#halfOpenProbes;
    }
    /** Note that a guarded call succeeded, closing the circuit once enough have. */
    recordSuccess() {
        if (this.#state === CircuitState.HALF_OPEN) {
            this.#successes++;
            if (this.#successes >= this.#successesToClose) {
                this.reset();
            }
            return;
        }
        this.#pruneFailures();
    }
    /**
     * Note that a guarded call failed, opening the circuit once enough have.
     *
     * Deduplicated within `#failureCoalesceMs`. One logical request is up to
     * `MAX_API_RETRY_ATTEMPTS` guarded calls landing within a few seconds, so
     * counting each separately meant two isolated flaky requests anywhere in the
     * window tripped a breaker configured for five failures — however many
     * hundreds of requests had succeeded in between.
     */
    recordFailure() {
        const now = Date.now();
        const previous = this.#failureTimestamps[this.#failureTimestamps.length - 1];
        const isSameBurst = previous !== undefined && now - previous < this.#failureCoalesceMs;
        this.#lastFailureTime = now;
        if (!isSameBurst) {
            this.#failureTimestamps.push(now);
        }
        if (this.#state === CircuitState.HALF_OPEN) {
            // Any failure while probing means the service is still unwell.
            this.#halfOpenRequests = 0;
            this.#successes = 0;
            this.#transitionTo(CircuitState.OPEN);
            return;
        }
        if (this.#state === CircuitState.CLOSED) {
            this.#pruneFailures();
            if (this.#failureTimestamps.length >= this.#failureThreshold) {
                this.#transitionTo(CircuitState.OPEN);
            }
        }
    }
    /** Return to the closed state and forget all recorded failures. */
    reset() {
        this.#successes = 0;
        this.#lastFailureTime = null;
        this.#halfOpenRequests = 0;
        this.#failureTimestamps = [];
        this.#transitionTo(CircuitState.CLOSED);
    }
    /** How long until the breaker will admit a probe, or `null` if it already will. */
    #remainingResetTimeMs() {
        return this.#state === CircuitState.OPEN && this.#lastFailureTime !== null
            ? Math.max(0, this.#resetTimeoutMs - (Date.now() - this.#lastFailureTime))
            : null;
    }
    /** Snapshot of breaker state, for diagnostics. */
    getStatus() {
        this.#pruneFailures();
        const remainingResetTimeMs = this.#remainingResetTimeMs();
        return {
            state: this.#state,
            failures: this.#failureTimestamps.length,
            remainingResetTimeMs,
        };
    }
    /**
     * Run an operation under the breaker.
     *
     * @throws {CircuitBreakerError} The circuit is open.
     */
    async execute(operation) {
        if (!this.canRequest()) {
            throw new errors_1.CircuitBreakerError(this.#remainingResetTimeMs() ?? this.#resetTimeoutMs);
        }
        const isProbe = this.#state === CircuitState.HALF_OPEN;
        if (isProbe) {
            this.#halfOpenRequests++;
        }
        try {
            const result = await operation();
            this.recordSuccess();
            return result;
        }
        catch (error) {
            this.recordFailure();
            throw error;
        }
        finally {
            // Released here rather than only in recordSuccess/recordFailure. Those
            // require the probe to settle, so a probe that never did left the counter
            // at its ceiling: canRequest() then refused every request forever, and
            // because the state was HALF_OPEN rather than OPEN the cooldown that
            // would have rescued it was never re-checked.
            if (isProbe) {
                this.#halfOpenRequests = Math.max(0, this.#halfOpenRequests - 1);
            }
        }
    }
}
exports.CircuitBreaker = CircuitBreaker;
//# sourceMappingURL=circuit-breaker.js.map