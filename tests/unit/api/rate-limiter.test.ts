/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Alarm.com publishes no rate limit; it just locks accounts that look like
 * scrapers. The two constraints that keep the plugin from looking like one —
 * minimum spacing and a per-window ceiling — are asserted independently.
 */

import { DEFAULT_RATE_LIMITER_CONFIG, RateLimiter } from '../../../src/api/rate-limiter'

/** Whether a promise has settled, without awaiting it. */
function track(promise: Promise<unknown>): { isSettled: () => boolean } {
  let settled = false
  void promise.then(() => {
    settled = true
  }, () => {
    settled = true
  })
  return { isSettled: () => settled }
}

describe('RateLimiter', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('lets the first request through immediately', async () => {
    const limiter = new RateLimiter({ minIntervalMs: 1_000 })

    await expect(limiter.acquire()).resolves.toBeUndefined()
    expect(limiter.getStatus().remaining).toBe(DEFAULT_RATE_LIMITER_CONFIG.maxRequests - 1)
  })

  it('spaces consecutive requests by the minimum interval', async () => {
    const limiter = new RateLimiter({ minIntervalMs: 1_000 })
    await limiter.acquire()

    const second = limiter.acquire()
    const tracked = track(second)

    await jest.advanceTimersByTimeAsync(999)
    expect(tracked.isSettled()).toBe(false)

    await jest.advanceTimersByTimeAsync(1)
    await second
    expect(tracked.isSettled()).toBe(true)
  })

  it('serves a burst in arrival order rather than letting callers race', async () => {
    const limiter = new RateLimiter({ minIntervalMs: 1_000 })
    const order: number[] = []

    const claims = [0, 1, 2].map((index) => limiter.acquire().then(() => order.push(index)))

    await jest.advanceTimersByTimeAsync(3_000)
    await Promise.all(claims)

    expect(order).toEqual([0, 1, 2])
  })

  it('holds requests back once the window ceiling is reached', async () => {
    const limiter = new RateLimiter({ minIntervalMs: 0, maxRequests: 2, windowMs: 1_000 })
    await limiter.acquire()
    await limiter.acquire()

    expect(limiter.getStatus().remaining).toBe(0)

    const third = limiter.acquire()
    const tracked = track(third)

    await jest.advanceTimersByTimeAsync(500)
    expect(tracked.isSettled()).toBe(false)

    await jest.advanceTimersByTimeAsync(500)
    await third
    expect(tracked.isSettled()).toBe(true)
  })

  it('lets requests flow again once the window has rolled past them', async () => {
    const limiter = new RateLimiter({ minIntervalMs: 0, maxRequests: 2, windowMs: 1_000 })
    await limiter.acquire()
    await limiter.acquire()

    await jest.advanceTimersByTimeAsync(1_001)

    // Both slots of this limiter's own two-request window are free again.
    expect(limiter.getStatus().remaining).toBe(2)
    await expect(limiter.acquire()).resolves.toBeUndefined()
  })

  it('refuses to queue a caller for longer than it is willing to wait', async () => {
    const limiter = new RateLimiter({ minIntervalMs: 10_000, maxWaitMs: 1_000 })
    await limiter.acquire()

    await expect(limiter.acquire()).rejects.toThrow(/exceeding the 1000ms limit/)
  })

  it('keeps serving later callers after one of them gave up', async () => {
    const limiter = new RateLimiter({ minIntervalMs: 10_000, maxWaitMs: 1_000 })
    await limiter.acquire()
    await expect(limiter.acquire()).rejects.toThrow(/Request pacing/)

    await jest.advanceTimersByTimeAsync(10_000)

    await expect(limiter.acquire()).resolves.toBeUndefined()
  })

  it('runs an operation once a slot is free', async () => {
    const limiter = new RateLimiter({ minIntervalMs: 0 })
    const operation = jest.fn().mockResolvedValue('ok')

    await expect(limiter.execute(operation)).resolves.toBe('ok')
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('does not claim a slot for an operation it never ran', async () => {
    const limiter = new RateLimiter({ minIntervalMs: 10_000, maxWaitMs: 1_000 })
    await limiter.acquire()
    const operation = jest.fn()

    await expect(limiter.execute(operation)).rejects.toThrow(/Request pacing/)
    expect(operation).not.toHaveBeenCalled()
  })

  it('reports how many slots are left in the window', async () => {
    const limiter = new RateLimiter({ minIntervalMs: 1_000, maxRequests: 60, windowMs: 60_000 })
    await limiter.acquire()

    expect(limiter.getStatus()).toEqual({ remaining: 59 })
  })

  it('defaults to one request a second and sixty a minute', () => {
    expect(DEFAULT_RATE_LIMITER_CONFIG).toMatchObject({
      minIntervalMs: 1_000,
      maxRequests: 60,
      windowMs: 60_000,
    })
  })

  it('applies those defaults when constructed without configuration', async () => {
    const limiter = new RateLimiter()
    await limiter.acquire()

    expect(limiter.getStatus().remaining)
      .toBe(DEFAULT_RATE_LIMITER_CONFIG.maxRequests - 1)

    // The default one-second minimum interval is what actually holds the second
    // request, which is the observable half of the default pacing.
    const claim = limiter.acquire()
    const second = track(claim)
    await jest.advanceTimersByTimeAsync(DEFAULT_RATE_LIMITER_CONFIG.minIntervalMs - 1)
    expect(second.isSettled()).toBe(false)
    await jest.advanceTimersByTimeAsync(1)
    await claim
    expect(second.isSettled()).toBe(true)
  })
})
