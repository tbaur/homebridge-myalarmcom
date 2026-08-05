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
    /** Ceiling on any single delay, including a server-supplied `Retry-After`. */
    maxDelayMs?: number;
    /** Called before each wait, for logging. */
    onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
    /** Injectable sleep, so tests need not wait in real time. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** Override which errors are worth another attempt. */
    isRetryable?: (error: unknown) => boolean;
    /** Abandons the retry loop, and any wait in progress, on shutdown. */
    signal?: AbortSignal;
}
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
export declare const sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
/**
 * Compute the delay before a given attempt.
 *
 * Exponential growth, capped, with up to ±25% jitter. The jitter matters
 * because several Homebridge instances behind one Alarm.com account would
 * otherwise retry in lockstep and look exactly like an attack.
 */
export declare function computeBackoffMs(attempt: number, baseDelayMs?: number, maxDelayMs?: number, random?: () => number): number;
export declare function withRetry<T>(operation: () => Promise<T>, options?: RetryOptions): Promise<T>;
//# sourceMappingURL=retry.d.ts.map