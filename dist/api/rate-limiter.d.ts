/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Client-side request pacing.
 *
 * Unlike a typical API, Alarm.com publishes no rate limit and returns no
 * `X-RateLimit` headers. What it does instead is lock accounts that it decides
 * are being scraped, which is unrecoverable without contacting the monitoring
 * provider. So this limiter is not about staying under a documented ceiling;
 * it is about never looking like a scraper in the first place.
 *
 * It enforces two independent constraints: a minimum gap between consecutive
 * requests (so a burst is spread out) and a ceiling per sliding window (so a
 * sustained trickle still cannot add up to abusive volume).
 */
export interface RateLimiterConfig {
    /** Minimum spacing between consecutive requests, in ms. */
    minIntervalMs: number;
    /** Maximum requests permitted within {@link RateLimiterConfig.windowMs}. */
    maxRequests: number;
    /** Sliding window length, in ms. */
    windowMs: number;
    /** Longest a caller will be made to wait before giving up. */
    maxWaitMs: number;
}
/**
 * Defaults chosen to be unmistakably polite.
 *
 * One request per second, 60 per minute. Discovery of a 20-device system takes
 * a handful of batched calls, so this is never the bottleneck in practice; it
 * only bites when something has gone wrong and is retrying in a loop, which is
 * exactly when it should.
 */
export declare const DEFAULT_RATE_LIMITER_CONFIG: RateLimiterConfig;
/** Snapshot of limiter state, for diagnostics. */
/**
 * Snapshot of pacing state, for diagnostics.
 *
 * Trimmed to what is consumed. `msUntilNextSlot` in particular cost a full wait
 * computation on every diagnostics heartbeat and was read by nothing.
 */
export interface RateLimiterStatus {
    /** Slots left in the current window. */
    remaining: number;
}
/** Paces outbound requests to Alarm.com. */
export declare class RateLimiter {
    #private;
    constructor(config?: Partial<RateLimiterConfig>);
    /** Snapshot of limiter state, for diagnostics. */
    getStatus(): RateLimiterStatus;
    /**
     * Wait until a request slot is available, then claim it.
     *
     * Callers are served in arrival order rather than racing, so a burst of
     * concurrent requests is spread evenly instead of clumping.
     *
     * @param signal Abandons a pending wait on shutdown.
     * @throws {RequestPacingError} The required wait exceeds `maxWaitMs`.
     * @throws {OperationAbortedError} The signal aborted during the wait.
     */
    acquire(signal?: AbortSignal): Promise<void>;
    /** Run an operation once a slot is available. */
    execute<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}
//# sourceMappingURL=rate-limiter.d.ts.map