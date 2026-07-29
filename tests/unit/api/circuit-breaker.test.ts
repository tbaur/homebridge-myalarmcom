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
  halfOpenMax: 2,
  failureWindowMs: 60_000,
}

function failTimes(breaker: CircuitBreaker, count: number): void {
  for (let index = 0; index < count; index++) {
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

    expect(breaker.state).toBe(CircuitState.CLOSED)
    expect(breaker.canRequest()).toBe(true)
    expect(breaker.isOpen).toBe(false)
  })

  it('opens once failures reach the threshold', () => {
    const breaker = new CircuitBreaker(CONFIG)

    failTimes(breaker, CONFIG.failureThreshold - 1)
    expect(breaker.state).toBe(CircuitState.CLOSED)

    breaker.recordFailure()
    expect(breaker.state).toBe(CircuitState.OPEN)
    expect(breaker.canRequest()).toBe(false)
  })

  it('forgets failures that age out of the sliding window', () => {
    const breaker = new CircuitBreaker(CONFIG)

    failTimes(breaker, CONFIG.failureThreshold - 1)
    jest.advanceTimersByTime(CONFIG.failureWindowMs + 1)
    breaker.recordFailure()

    expect(breaker.state).toBe(CircuitState.CLOSED)
    expect(breaker.getStatus().failures).toBe(1)
  })

  it('probes again after the cooldown by moving to half-open', () => {
    const breaker = new CircuitBreaker(CONFIG)
    failTimes(breaker, CONFIG.failureThreshold)

    jest.advanceTimersByTime(CONFIG.resetTimeoutMs - 1)
    expect(breaker.canRequest()).toBe(false)
    expect(breaker.state).toBe(CircuitState.OPEN)

    jest.advanceTimersByTime(1)
    expect(breaker.canRequest()).toBe(true)
    expect(breaker.state).toBe(CircuitState.HALF_OPEN)
  })

  it('reopens on the first failure while probing', () => {
    const breaker = new CircuitBreaker(CONFIG)
    failTimes(breaker, CONFIG.failureThreshold)
    jest.advanceTimersByTime(CONFIG.resetTimeoutMs)
    breaker.canRequest()

    breaker.recordFailure()

    expect(breaker.state).toBe(CircuitState.OPEN)
  })

  it('closes once enough probes succeed', () => {
    const breaker = new CircuitBreaker(CONFIG)
    failTimes(breaker, CONFIG.failureThreshold)
    jest.advanceTimersByTime(CONFIG.resetTimeoutMs)
    breaker.canRequest()

    breaker.recordSuccess()
    expect(breaker.state).toBe(CircuitState.HALF_OPEN)

    breaker.recordSuccess()
    expect(breaker.state).toBe(CircuitState.CLOSED)
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
      isOpen: true,
      remainingResetTimeMs: CONFIG.resetTimeoutMs - 10_000,
    })
  })

  it('reports no reset time while closed', () => {
    expect(new CircuitBreaker(CONFIG).getStatus().remainingResetTimeMs).toBeNull()
  })

  it('can be reset by hand', () => {
    const breaker = new CircuitBreaker(CONFIG)
    failTimes(breaker, CONFIG.failureThreshold)

    breaker.reset()

    expect(breaker.state).toBe(CircuitState.CLOSED)
    expect(breaker.getStatus()).toMatchObject({ failures: 0, lastFailureTime: null })
  })

  it('defaults to the shipped tuning when none is given', () => {
    const breaker = new CircuitBreaker()

    failTimes(breaker, DEFAULT_CIRCUIT_BREAKER_CONFIG.failureThreshold - 1)
    expect(breaker.state).toBe(CircuitState.CLOSED)

    breaker.recordFailure()
    expect(breaker.state).toBe(CircuitState.OPEN)
  })

  describe('execute', () => {
    it('returns the operation result and counts the success', async () => {
      const breaker = new CircuitBreaker(CONFIG)

      await expect(breaker.execute(() => Promise.resolve('ok'))).resolves.toBe('ok')
      expect(breaker.state).toBe(CircuitState.CLOSED)
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

      for (let probe = 0; probe < CONFIG.halfOpenMax; probe++) {
        await breaker.execute(() => Promise.resolve('ok'))
      }

      expect(breaker.state).toBe(CircuitState.CLOSED)
      await expect(breaker.execute(() => Promise.resolve('ok'))).resolves.toBe('ok')
    })
  })
})
