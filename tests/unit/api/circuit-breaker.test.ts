/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The breaker exists to protect the user's Alarm.com account from sustained
 * failing traffic, so the transitions are asserted precisely. Fake timers stand
 * in for the cooldown and the sliding window.
 */

import {
  CircuitBreaker,
  CircuitState,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from '../../../src/api/circuit-breaker'
import { CircuitBreakerError } from '../../../src/errors'

const CONFIG = {
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
  successesToClose: 2,
  halfOpenProbes: 2,
  failureWindowMs: 60_000,
  failureCoalesceMs: 1_000,
}

/**
 * Record `count` failures of `count` *distinct* logical requests.
 *
 * The clock is advanced past the coalescing window between them, because that is
 * what separates "one request that retried three times" from "three requests that
 * each failed" — and the breaker counts the latter. Without the advance, frozen
 * fake timers make every failure part of the same burst.
 */
function failTimes(breaker: CircuitBreaker, count: number): void {
  for (let index = 0; index < count; index++) {
    if (index > 0) {
      jest.advanceTimersByTime(CONFIG.failureCoalesceMs + 1)
    }
    breaker.recordFailure()
  }
}

describe('CircuitBreaker', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('starts closed and lets requests through', () => {
    const breaker = new CircuitBreaker(CONFIG)

    expect(breaker.getStatus().state).toBe(CircuitState.CLOSED)
    expect(breaker.canRequest()).toBe(true)
    expect(breaker.isOpen).toBe(false)
  })

  it('opens once failures reach the threshold', () => {
    const breaker = new CircuitBreaker(CONFIG)

    failTimes(breaker, CONFIG.failureThreshold - 1)
    expect(breaker.getStatus().state).toBe(CircuitState.CLOSED)

    jest.advanceTimersByTime(CONFIG.failureCoalesceMs + 1)
    breaker.recordFailure()
    expect(breaker.getStatus().state).toBe(CircuitState.OPEN)
    expect(breaker.canRequest()).toBe(false)
  })

  /**
   * One logical request is several guarded calls: the retry loop runs up to
   * MAX_API_RETRY_ATTEMPTS within a couple of seconds. Counting each separately
   * meant two isolated flaky requests anywhere in the five-minute window tripped
   * a breaker configured for five failures, however many hundreds of requests
   * had succeeded between them.
   */
  it('counts one failing request as one failure however many times it retried', () => {
    const breaker = new CircuitBreaker(CONFIG)

    for (let attempt = 0; attempt < 10; attempt++) {
      jest.advanceTimersByTime(100)
      breaker.recordFailure()
    }

    expect(breaker.getStatus().failures).toBe(1)
    expect(breaker.getStatus().state).toBe(CircuitState.CLOSED)
  })

  it('forgets failures that age out of the sliding window', () => {
    const breaker = new CircuitBreaker(CONFIG)

    failTimes(breaker, CONFIG.failureThreshold - 1)
    jest.advanceTimersByTime(CONFIG.failureWindowMs + 1)
    breaker.recordFailure()

    expect(breaker.getStatus().state).toBe(CircuitState.CLOSED)
    expect(breaker.getStatus().failures).toBe(1)
  })

  it('probes again after the cooldown by moving to half-open', () => {
    const breaker = new CircuitBreaker(CONFIG)
    failTimes(breaker, CONFIG.failureThreshold)

    jest.advanceTimersByTime(CONFIG.resetTimeoutMs - 1)
    expect(breaker.canRequest()).toBe(false)
    expect(breaker.getStatus().state).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1)
    expect(breaker.canRequest()).toBe(true)
    expect(breaker.getStatus().state).toBe(CircuitState.HALF_OPEN)
  })

  it('reopens on the first failure while probing', () => {
    const breaker = new CircuitBreaker(CONFIG)
    failTimes(breaker, CONFIG.failureThreshold)
    jest.advanceTimersByTime(CONFIG.resetTimeoutMs)
    breaker.canRequest()

    breaker.recordFailure()

    expect(breaker.getStatus().state).toBe(CircuitState.OPEN)
  })

  it('closes once enough probes succeed', () => {
    const breaker = new CircuitBreaker(CONFIG)
    failTimes(breaker, CONFIG.failureThreshold)
    jest.advanceTimersByTime(CONFIG.resetTimeoutMs)
    breaker.canRequest()

    breaker.recordSuccess()
    expect(breaker.getStatus().state).toBe(CircuitState.HALF_OPEN)

    breaker.recordSuccess()
    expect(breaker.getStatus().state).toBe(CircuitState.CLOSED)
    expect(breaker.getStatus().failures).toBe(0)
  })

  it('limits how many probes run at once while half-open', () => {
    const breaker = new CircuitBreaker(CONFIG)
    failTimes(breaker, CONFIG.failureThreshold)
    jest.advanceTimersByTime(CONFIG.resetTimeoutMs)

    expect(breaker.canRequest()).toBe(true)
    void breaker.execute(() => new Promise(() => undefined))
    void breaker.execute(() => new Promise(() => undefined))

    expect(breaker.canRequest()).toBe(false)
  })

  /**
   * Regression. The probe slot was released only by recordSuccess/recordFailure,
   * both of which need the probe to settle. A probe that never did pinned the
   * counter at its ceiling, and because the state was HALF_OPEN rather than
   * OPEN the cooldown re-check never ran — so every subsequent request failed
   * for the life of the process.
   */
  it('releases a probe slot even when the probe rejects', async () => {
    const breaker = new CircuitBreaker(CONFIG)
    failTimes(breaker, CONFIG.failureThreshold)
    jest.advanceTimersByTime(CONFIG.resetTimeoutMs)
    breaker.canRequest()

    await expect(breaker.execute(() => Promise.reject(new Error('still down'))))
      .rejects.toThrow('still down')

    expect(breaker.getStatus().state).toBe(CircuitState.OPEN)
    jest.advanceTimersByTime(CONFIG.resetTimeoutMs)
    expect(breaker.canRequest()).toBe(true)
  })

  it('tunes probe concurrency and the close threshold independently', async () => {
    const breaker = new CircuitBreaker({ ...CONFIG, halfOpenProbes: 1, successesToClose: 3 })
    failTimes(breaker, CONFIG.failureThreshold)
    jest.advanceTimersByTime(CONFIG.resetTimeoutMs)
    breaker.canRequest()

    await breaker.execute(() => Promise.resolve('ok'))
    await breaker.execute(() => Promise.resolve('ok'))
    expect(breaker.getStatus().state).toBe(CircuitState.HALF_OPEN)

    await breaker.execute(() => Promise.resolve('ok'))
    expect(breaker.getStatus().state).toBe(CircuitState.CLOSED)
  })

  it('announces every state change once', () => {
    const onStateChange = jest.fn()
    const breaker = new CircuitBreaker({ ...CONFIG, onStateChange })

    failTimes(breaker, CONFIG.failureThreshold)
    failTimes(breaker, CONFIG.failureThreshold)

    expect(onStateChange).toHaveBeenCalledTimes(1)
    expect(onStateChange).toHaveBeenCalledWith(CircuitState.CLOSED, CircuitState.OPEN)
  })

  it('reports how long is left before the next probe', () => {
    const breaker = new CircuitBreaker(CONFIG)
    failTimes(breaker, CONFIG.failureThreshold)

    jest.advanceTimersByTime(10_000)

    expect(breaker.getStatus()).toMatchObject({
      state: CircuitState.OPEN,
      remainingResetTimeMs: CONFIG.resetTimeoutMs - 10_000,
    })
    expect(breaker.isOpen).toBe(true)
  })

  it('reports no reset time while closed', () => {
    expect(new CircuitBreaker(CONFIG).getStatus().remainingResetTimeMs).toBeNull()
  })

  it('can be reset by hand', () => {
    const breaker = new CircuitBreaker(CONFIG)
    failTimes(breaker, CONFIG.failureThreshold)

    breaker.reset()

    expect(breaker.getStatus()).toMatchObject({
      state: CircuitState.CLOSED,
      failures: 0,
      remainingResetTimeMs: null,
    })
  })

  it('defaults to the shipped tuning when none is given', () => {
    const breaker = new CircuitBreaker()

    // Advanced past the shipped coalescing window between failures, so each one
    // stands for a separate failing request rather than one request's retries.
    for (let index = 0; index < DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold - 1; index++) {
      jest.advanceTimersByTime(DEFAULT_CIRCUIT_BREAKER_CONFIG.failureCoalesceMs + 1)
      breaker.recordFailure()
    }
    expect(breaker.getStatus().state).toBe(CircuitState.CLOSED)

    jest.advanceTimersByTime(DEFAULT_CIRCUIT_BREAKER_CONFIG.failureCoalesceMs + 1)
    breaker.recordFailure()
    expect(breaker.getStatus().state).toBe(CircuitState.OPEN)
  })

  describe('execute', () => {
    it('returns the operation result and counts the success', async () => {
      const breaker = new CircuitBreaker(CONFIG)

      await expect(breaker.execute(() => Promise.resolve('ok'))).resolves.toBe('ok')
      expect(breaker.getStatus().state).toBe(CircuitState.CLOSED)
    })

    it('records the failure and rethrows what the operation threw', async () => {
      const breaker = new CircuitBreaker(CONFIG)

      await expect(breaker.execute(() => Promise.reject(new Error('boom'))))
        .rejects.toThrow('boom')
      expect(breaker.getStatus().failures).toBe(1)
    })

    it('fails fast without calling the operation once open', async () => {
      const breaker = new CircuitBreaker(CONFIG)
      failTimes(breaker, CONFIG.failureThreshold)
      const operation = jest.fn()

      await expect(breaker.execute(operation)).rejects.toThrow(CircuitBreakerError)
      expect(operation).not.toHaveBeenCalled()
    })

    it('tells the caller when to try again', async () => {
      const breaker = new CircuitBreaker(CONFIG)
      failTimes(breaker, CONFIG.failureThreshold)

      const error = await breaker.execute(() => Promise.resolve('ok'))
        .then(() => null, (thrown: CircuitBreakerError) => thrown)

      expect(error?.retryAfterMs).toBe(CONFIG.resetTimeoutMs)
    })

    it('lets traffic through again after a successful recovery', async () => {
      const breaker = new CircuitBreaker(CONFIG)
      failTimes(breaker, CONFIG.failureThreshold)
      jest.advanceTimersByTime(CONFIG.resetTimeoutMs)

      for (let probe = 0; probe < CONFIG.successesToClose; probe++) {
        await breaker.execute(() => Promise.resolve('ok'))
      }

      expect(breaker.getStatus().state).toBe(CircuitState.CLOSED)
      await expect(breaker.execute(() => Promise.resolve('ok'))).resolves.toBe('ok')
    })
  })
})
