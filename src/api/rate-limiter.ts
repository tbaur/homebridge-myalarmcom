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

import { RequestPacingError } from '../errors'
import { MS_PER_MINUTE, MS_PER_SECOND } from '../settings'
import { sleep } from '../utils/retry'

export interface RateLimiterConfig {
  /** Minimum spacing between consecutive requests, in ms. */
  minIntervalMs: number
  /** Maximum requests permitted within {@link RateLimiterConfig.windowMs}. */
  maxRequests: number
  /** Sliding window length, in ms. */
  windowMs: number
  /** Longest a caller will be made to wait before giving up. */
  maxWaitMs: number
}

/**
 * Defaults chosen to be unmistakably polite.
 *
 * One request per second, 60 per minute. Discovery of a 20-device system takes
 * a handful of batched calls, so this is never the bottleneck in practice; it
 * only bites when something has gone wrong and is retrying in a loop, which is
 * exactly when it should.
 */
export const DEFAULT_RATE_LIMITER_CONFIG: RateLimiterConfig = {
  minIntervalMs: MS_PER_SECOND,
  maxRequests: 60,
  windowMs: MS_PER_MINUTE,
  maxWaitMs: 30 * MS_PER_SECOND,
}

/** Snapshot of limiter state, for diagnostics. */
/**
 * Snapshot of pacing state, for diagnostics.
 *
 * Trimmed to what is consumed. `msUntilNextSlot` in particular cost a full wait
 * computation on every diagnostics heartbeat and was read by nothing.
 */
export interface RateLimiterStatus {
  /** Slots left in the current window. */
  remaining: number
}

/** Paces outbound requests to Alarm.com. */
export class RateLimiter {
  readonly #minIntervalMs: number
  readonly #maxRequests: number
  readonly #windowMs: number
  readonly #maxWaitMs: number

  #timestamps: number[] = []
  /** Serialises waiters so concurrent callers queue rather than all race. */
  #tail: Promise<void> = Promise.resolve()

  constructor(config: Partial<RateLimiterConfig> = {}) {
    const merged = { ...DEFAULT_RATE_LIMITER_CONFIG, ...config }
    this.#minIntervalMs = merged.minIntervalMs
    this.#maxRequests = merged.maxRequests
    this.#windowMs = merged.windowMs
    this.#maxWaitMs = merged.maxWaitMs
  }

  #prune(now: number): void {
    this.#timestamps = this.#timestamps.filter((ts) => now - ts < this.#windowMs)
  }

  /**
   * How long the caller must wait before a request is permissible.
   *
   * Assumes the window has already been pruned for `now`, so callers that
   * pruned to make a decision of their own do not pay for a second pass.
   */
  #computeWaitMs(now: number): number {
    const last = this.#timestamps[this.#timestamps.length - 1]
    const spacingWait = last === undefined
      ? 0
      : Math.max(0, this.#minIntervalMs - (now - last))

    const oldest = this.#timestamps[0]
    if (this.#timestamps.length < this.#maxRequests || oldest === undefined) {
      return spacingWait
    }

    // Window is full: wait for the oldest entry to age out.
    return Math.max(spacingWait, this.#windowMs - (now - oldest))
  }

  /** Snapshot of limiter state, for diagnostics. */
  getStatus(): RateLimiterStatus {
    this.#prune(Date.now())
    return { remaining: Math.max(0, this.#maxRequests - this.#timestamps.length) }
  }

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
  async acquire(signal?: AbortSignal): Promise<void> {
    const claim = this.#tail.then(async () => {
      const now = Date.now()
      this.#prune(now)
      const waitMs = this.#computeWaitMs(now)

      if (waitMs > this.#maxWaitMs) {
        throw new RequestPacingError(waitMs, this.#maxWaitMs)
      }

      if (waitMs > 0) {
        await sleep(waitMs, signal)
      }

      this.#timestamps.push(Date.now())
    })

    // Keep the chain alive even when a claim rejects, or one failure would
    // permanently wedge every subsequent caller.
    this.#tail = claim.catch(() => undefined)

    return claim
  }

  /** Run an operation once a slot is available. */
  async execute<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal)
    return operation()
  }

}
