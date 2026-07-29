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
/** Resolve after the given delay. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
    const jitterRange = exponential * 0.25;
    const jitter = (random() * 2 - 1) * jitterRange;
    return Math.max(0, Math.round(exponential + jitter));
}
/** Whether a thrown value is worth another attempt. */
function isRetryable(error) {
    return error instanceof errors_1.AlarmComError && error.isRetryable;
}
/**
 * Run an operation, retrying retryable failures with backoff.
 *
 * Only errors that declare themselves retryable are retried; everything else
 * propagates immediately. A `Retry-After` from Alarm.com always wins over the
 * computed backoff, since arguing with a rate limiter is how accounts get
 * locked.
 *
 * @param operation Must be idempotent. Do not wrap arming commands in this.
 */
async function withRetry(operation, options = {}) {
    const { maxAttempts = settings_1.MAX_API_RETRY_ATTEMPTS, baseDelayMs = DEFAULT_BASE_DELAY_MS, maxDelayMs = settings_1.MAX_RETRY_BACKOFF_MS, onRetry, sleep: wait = exports.sleep, isRetryable: shouldRetry = isRetryable, } = options;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await operation();
        }
        catch (error) {
            lastError = error;
            if (!shouldRetry(error) || attempt === maxAttempts) {
                throw error;
            }
            const serverDelay = error instanceof errors_1.RateLimitError ? error.retryAfterMs : undefined;
            const delayMs = serverDelay ?? computeBackoffMs(attempt, baseDelayMs, maxDelayMs);
            onRetry?.(attempt, delayMs, error);
            await wait(delayMs);
        }
    }
    throw lastError;
}
//# sourceMappingURL=retry.js.map