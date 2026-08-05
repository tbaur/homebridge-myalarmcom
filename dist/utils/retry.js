"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Retry with exponential backoff and jitter.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sleep = void 0;
exports.computeBackoffMs = computeBackoffMs;
exports.withRetry = withRetry;
const errors_1 = require("../errors");
const settings_1 = require("../settings");
const DEFAULT_BASE_DELAY_MS = 1_000;
/**
 * How far either side of the computed delay the jitter may reach.
 *
 * Named because the docblock on {@link computeBackoffMs} already refers to it.
 */
const JITTER_FACTOR = 0.25;
/**
 * Resolve after the given delay, or reject if the signal aborts first.
 *
 * The timer is `unref`'d so a pending backoff cannot hold Node open past
 * shutdown. That matters here because the waits are long: retry backoff runs to
 * a minute and the initial-discovery backoff to five, and a child bridge that
 * refuses to exit for five minutes looks like a hang.
 *
 * @throws {OperationAbortedError} The signal aborted before the delay elapsed.
 */
const sleep = (ms, signal) => {
    if (signal?.aborted === true) {
        return Promise.reject(new errors_1.OperationAbortedError('Wait cancelled before it started'));
    }
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        timer.unref?.();
        const onAbort = () => {
            clearTimeout(timer);
            reject(new errors_1.OperationAbortedError('Wait cancelled'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
};
exports.sleep = sleep;
/**
 * Compute the delay before a given attempt.
 *
 * Exponential growth, capped, with up to ±25% jitter. The jitter matters
 * because several Homebridge instances behind one Alarm.com account would
 * otherwise retry in lockstep and look exactly like an attack.
 */
function computeBackoffMs(attempt, baseDelayMs = DEFAULT_BASE_DELAY_MS, maxDelayMs = settings_1.MAX_RETRY_BACKOFF_MS, random = Math.random) {
    const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
    const jitter = (random() * 2 - 1) * exponential * JITTER_FACTOR;
    // Clamped after jitter, not before. Applying the cap first and then adding up
    // to +25% let the delay sit a quarter above the ceiling that `resolveDelayMs`
    // refuses a *server* hint for exceeding.
    return Math.min(maxDelayMs, Math.max(0, Math.round(exponential + jitter)));
}
/** Whether a thrown value is worth another attempt. */
function isRetryable(error) {
    return error instanceof errors_1.AlarmComError && error.isRetryable;
}
/**
 * A wait the server asked for, if it asked for one.
 *
 * Both {@link RateLimitError} and {@link LoginThrottledError} carry a deadline
 * the plugin should respect rather than guess at.
 */
function serverRequestedDelayMs(error) {
    if (error instanceof errors_1.RateLimitError) {
        return error.retryAfterMs;
    }
    if (error instanceof errors_1.LoginThrottledError) {
        return error.retryAfterMs;
    }
    return undefined;
}
/**
 * Reconcile a server-requested wait with the computed backoff.
 *
 * A server hint is respected but not obeyed blindly. It is remote-controlled
 * and, for an HTTP-date, subject to clock skew, so it is bounded on both sides:
 *
 * - Floored at the computed backoff, because a skewed date parses to `0` and
 *   would otherwise retry instantly against a service that just said slow down.
 * - Capped at `maxDelayMs`, returning `null` beyond it. A `Retry-After: 86400`
 *   is not a wait to sleep through inside a poll cycle — that holds the cycle's
 *   in-flight flag for a day and silently stops all polling.
 */
function resolveDelayMs(error, attempt, baseDelayMs, maxDelayMs) {
    const backoffMs = computeBackoffMs(attempt, baseDelayMs, maxDelayMs);
    const serverDelayMs = serverRequestedDelayMs(error);
    if (serverDelayMs === undefined) {
        return backoffMs;
    }
    if (serverDelayMs > maxDelayMs) {
        return null;
    }
    return Math.max(serverDelayMs, backoffMs);
}
/**
 * Run an operation, retrying retryable failures with backoff.
 *
 * Only errors that declare themselves retryable are retried; everything else
 * propagates immediately. A `Retry-After` from Alarm.com wins over the computed
 * backoff within the configured ceiling, since arguing with a rate limiter is
 * how accounts get locked; beyond the ceiling the retry is abandoned so the
 * caller's own schedule can decide when to try again.
 *
 * @param operation Must be idempotent. Do not wrap arming commands in this.
 * @throws {OperationAbortedError} `options.signal` aborted during a wait.
 */
/**
 * Numeric defaults only.
 *
 * `sleep` and `isRetryable` stay resolved at call time below: capturing them
 * here would freeze the binding at module load, and both are seams that tests
 * replace afterwards.
 */
const RETRY_DEFAULTS = {
    maxAttempts: settings_1.MAX_API_RETRY_ATTEMPTS,
    baseDelayMs: DEFAULT_BASE_DELAY_MS,
    maxDelayMs: settings_1.MAX_RETRY_BACKOFF_MS,
};
async function withRetry(operation, options = {}) {
    // Numeric defaults merged rather than destructured one by one: as inline
    // defaults they dominated this function's measured complexity while saying
    // nothing about what it does. `exactOptionalPropertyTypes` stops a caller
    // passing an explicit `undefined`, so a spread cannot erase a default.
    const { maxAttempts, baseDelayMs, maxDelayMs, onRetry, signal } = {
        ...RETRY_DEFAULTS,
        ...options,
    };
    const wait = options.sleep ?? exports.sleep;
    const shouldRetry = options.isRetryable ?? isRetryable;
    for (let attempt = 1;; attempt++) {
        try {
            return await operation();
        }
        catch (error) {
            if (!shouldRetry(error) || attempt >= maxAttempts) {
                throw error;
            }
            const delayMs = resolveDelayMs(error, attempt, baseDelayMs, maxDelayMs);
            if (delayMs === null) {
                throw error;
            }
            onRetry?.(attempt, delayMs, error);
            await wait(delayMs, signal);
        }
    }
}
//# sourceMappingURL=retry.js.map