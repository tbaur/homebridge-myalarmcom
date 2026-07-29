/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Retry with exponential backoff and jitter.
 */
/** Tuning for {@link withRetry}. */
export interface RetryOptions {
    /** Total attempts including the first. */
    maxAttempts?: number;
    /** Delay before the second attempt, doubled each time after. */
    baseDelayMs?: number;
    /** Ceiling on any single delay. */
    maxDelayMs?: number;
    /** Called before each wait, for logging. */
    onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
    /** Injectable sleep, so tests need not wait in real time. */
    sleep?: (ms: number) => Promise<void>;
}
/** Resolve after the given delay. */
export declare const sleep: (ms: number) => Promise<void>;
/**
 * Compute the delay before a given attempt.
 *
 * Exponential growth, capped, with up to ±25% jitter. The jitter matters
 * because several Homebridge instances behind one Alarm.com account would
 * otherwise retry in lockstep and look exactly like an attack.
 */
export declare function computeBackoffMs(attempt: number, baseDelayMs?: number, maxDelayMs?: number, random?: () => number): number;
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
export declare function withRetry<T>(operation: () => Promise<T>, options?: RetryOptions): Promise<T>;
//# sourceMappingURL=retry.d.ts.map