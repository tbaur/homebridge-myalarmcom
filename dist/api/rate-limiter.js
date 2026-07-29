"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.RateLimiter = exports.DEFAULT_RATE_LIMITER_CONFIG = void 0;
const retry_1 = require("../utils/retry");
/**
 * Defaults chosen to be unmistakably polite.
 *
 * One request per second, 60 per minute. Discovery of a 20-device system takes
 * a handful of batched calls, so this is never the bottleneck in practice; it
 * only bites when something has gone wrong and is retrying in a loop, which is
 * exactly when it should.
 */
exports.DEFAULT_RATE_LIMITER_CONFIG = {
    minIntervalMs: 1_000,
    maxRequests: 60,
    windowMs: 60_000,
    maxWaitMs: 30_000,
};
/** Paces outbound requests to Alarm.com. */
class RateLimiter {
    #minIntervalMs;
    #maxRequests;
    #windowMs;
    #maxWaitMs;
    #timestamps = [];
    /** Serialises waiters so concurrent callers queue rather than all race. */
    #tail = Promise.resolve();
    constructor(config = {}) {
        const merged = { ...exports.DEFAULT_RATE_LIMITER_CONFIG, ...config };
        this.#minIntervalMs = merged.minIntervalMs;
        this.#maxRequests = merged.maxRequests;
        this.#windowMs = merged.windowMs;
        this.#maxWaitMs = merged.maxWaitMs;
    }
    #prune(now) {
        this.#timestamps = this.#timestamps.filter((ts) => now - ts < this.#windowMs);
    }
    /** How long the caller must wait before a request is permissible. */
    #computeWaitMs(now) {
        this.#prune(now);
        const last = this.#timestamps[this.#timestamps.length - 1];
        const spacingWait = last === undefined
            ? 0
            : Math.max(0, this.#minIntervalMs - (now - last));
        if (this.#timestamps.length < this.#maxRequests) {
            return spacingWait;
        }
        // Window is full: wait for the oldest entry to age out.
        const windowWait = this.#windowMs - (now - this.#timestamps[0]);
        return Math.max(spacingWait, windowWait);
    }
    getStatus() {
        const now = Date.now();
        this.#prune(now);
        return {
            requestsInWindow: this.#timestamps.length,
            maxRequests: this.#maxRequests,
            remaining: Math.max(0, this.#maxRequests - this.#timestamps.length),
            msUntilNextSlot: this.#computeWaitMs(now),
        };
    }
    /**
     * Wait until a request slot is available, then claim it.
     *
     * Callers are served in arrival order rather than racing, so a burst of
     * concurrent requests is spread evenly instead of clumping.
     *
     * @throws {Error} The required wait exceeds `maxWaitMs`.
     */
    async acquire() {
        const claim = this.#tail.then(async () => {
            const waitMs = this.#computeWaitMs(Date.now());
            if (waitMs > this.#maxWaitMs) {
                throw new Error(`Request pacing would require waiting ${waitMs}ms, exceeding the ${this.#maxWaitMs}ms limit`);
            }
            if (waitMs > 0) {
                await (0, retry_1.sleep)(waitMs);
            }
            this.#timestamps.push(Date.now());
        });
        // Keep the chain alive even when a claim rejects, or one failure would
        // permanently wedge every subsequent caller.
        this.#tail = claim.catch(() => undefined);
        return claim;
    }
    /** Run an operation once a slot is available. */
    async execute(operation) {
        await this.acquire();
        return operation();
    }
    reset() {
        this.#timestamps = [];
        this.#tail = Promise.resolve();
    }
}
exports.RateLimiter = RateLimiter;
//# sourceMappingURL=rate-limiter.js.map