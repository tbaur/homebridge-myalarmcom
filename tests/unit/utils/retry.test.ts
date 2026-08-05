/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Both the jitter source and the sleep are injectable, so these tests are
 * deterministic and never actually wait.
 */

import {
  ApiParseError,
  ConfigurationError,
  LoginThrottledError,
  NetworkError,
  OperationAbortedError,
  RateLimitError,
} from '../../../src/errors'
import { computeBackoffMs, sleep, withRetry } from '../../../src/utils/retry'

/** A jitter source producing no jitter, so growth can be asserted exactly. */
const noJitter = (): number => 0.5

describe('computeBackoffMs', () => {
  it('doubles the delay on each attempt', () => {
    expect(computeBackoffMs(1, 1_000, 60_000, noJitter)).toBe(1_000)
    expect(computeBackoffMs(2, 1_000, 60_000, noJitter)).toBe(2_000)
    expect(computeBackoffMs(3, 1_000, 60_000, noJitter)).toBe(4_000)
    expect(computeBackoffMs(4, 1_000, 60_000, noJitter)).toBe(8_000)
  })

  it('never exceeds the cap, however many attempts have failed', () => {
    expect(computeBackoffMs(20, 1_000, 60_000, noJitter)).toBe(60_000)
    expect(computeBackoffMs(20, 5_000, 10_000, noJitter)).toBe(10_000)
  })

  it('spreads the delay by up to a quarter either way', () => {
    expect(computeBackoffMs(1, 1_000, 60_000, () => 1)).toBe(1_250)
    expect(computeBackoffMs(1, 1_000, 60_000, () => 0)).toBe(750)
    expect(computeBackoffMs(3, 1_000, 60_000, () => 0)).toBe(3_000)
  })

  it('applies jitter to the capped delay too, so retries do not synchronise', () => {
    expect(computeBackoffMs(20, 1_000, 60_000, () => 0)).toBe(45_000)
  })

  /**
   * The cap is documented as a ceiling on any single delay, and `resolveDelayMs`
   * refuses a *server* hint for exceeding it. Clamping before adding jitter let
   * the plugin's own computed delay sit a quarter above the same ceiling.
   */
  it('never exceeds the cap even with jitter pushing upward', () => {
    expect(computeBackoffMs(20, 1_000, 60_000, () => 1)).toBe(60_000)
    expect(computeBackoffMs(1_024, 5_000, 300_000, () => 1)).toBe(300_000)
  })

  it('never returns a negative delay', () => {
    expect(computeBackoffMs(1, 0, 60_000, () => 0)).toBe(0)
  })

  it('uses Math.random by default, staying inside the jitter band', () => {
    for (let index = 0; index < 50; index++) {
      const delay = computeBackoffMs(2, 1_000)
      expect(delay).toBeGreaterThanOrEqual(1_500)
      expect(delay).toBeLessThanOrEqual(2_500)
    }
  })
})

describe('withRetry', () => {
  let waits: number[]
  let wait: (ms: number, signal?: AbortSignal) => Promise<void>

  beforeEach(() => {
    waits = []
    wait = (ms: number): Promise<void> => {
      waits.push(ms)
      return Promise.resolve()
    }
  })

  it('returns the first successful result without waiting', async () => {
    const operation = jest.fn().mockResolvedValue('ok')

    await expect(withRetry(operation, { sleep: wait })).resolves.toBe('ok')
    expect(operation).toHaveBeenCalledTimes(1)
    expect(waits).toEqual([])
  })

  it('retries an error that declares itself retryable', async () => {
    const operation = jest.fn()
      .mockRejectedValueOnce(new NetworkError('connection reset'))
      .mockResolvedValue('ok')

    await expect(withRetry(operation, { sleep: wait })).resolves.toBe('ok')
    expect(operation).toHaveBeenCalledTimes(2)
    expect(waits).toHaveLength(1)
  })

  it('gives up immediately on an error that is not retryable', async () => {
    const operation = jest.fn().mockRejectedValue(new ConfigurationError('bad password'))

    await expect(withRetry(operation, { sleep: wait })).rejects.toThrow(ConfigurationError)
    expect(operation).toHaveBeenCalledTimes(1)
    expect(waits).toEqual([])
  })

  it('gives up immediately on a plain Error, which cannot say it is retryable', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('something else'))

    await expect(withRetry(operation, { sleep: wait })).rejects.toThrow('something else')
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('stops at maxAttempts and rethrows the last failure', async () => {
    const operation = jest.fn().mockRejectedValue(new ApiParseError('html instead of json'))

    await expect(withRetry(operation, { maxAttempts: 4, sleep: wait }))
      .rejects.toThrow(ApiParseError)
    expect(operation).toHaveBeenCalledTimes(4)
    expect(waits).toHaveLength(3)
  })

  it('makes a single attempt when told to', async () => {
    const operation = jest.fn().mockRejectedValue(new NetworkError('down'))

    await expect(withRetry(operation, { maxAttempts: 1, sleep: wait })).rejects.toThrow(NetworkError)
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('grows the wait between attempts', async () => {
    const operation = jest.fn().mockRejectedValue(new NetworkError('down'))

    await expect(withRetry(operation, { maxAttempts: 3, baseDelayMs: 1_000, sleep: wait }))
      .rejects.toThrow(NetworkError)
    expect(waits).toHaveLength(2)
    expect(waits[1]).toBeGreaterThan(waits[0] ?? 0)
  })

  describe('a Retry-After the server asked for', () => {
    it('is honoured over the computed backoff', async () => {
      const operation = jest.fn()
        .mockRejectedValueOnce(new RateLimitError('slow down', { retryAfterMs: 7_500 }))
        .mockResolvedValue('ok')

      await expect(withRetry(operation, { baseDelayMs: 1_000, sleep: wait })).resolves.toBe('ok')
      expect(waits).toEqual([7_500])
    })

    /**
     * `Retry-After: 86400` is either a mistake or a punishment. Sleeping
     * through it inside a poll cycle holds that cycle's in-flight guard for a
     * day, which silently stops all polling.
     */
    it('is abandoned rather than slept through when it exceeds the ceiling', async () => {
      const operation = jest.fn()
        .mockRejectedValue(new RateLimitError('come back tomorrow', { retryAfterMs: 86_400_000 }))

      await expect(withRetry(operation, { maxDelayMs: 60_000, sleep: wait }))
        .rejects.toThrow(RateLimitError)
      expect(operation).toHaveBeenCalledTimes(1)
      expect(waits).toEqual([])
    })

    /**
     * An HTTP-date `Retry-After` parses to `0` when the local clock runs ahead
     * of the server's, which would retry instantly against a service that just
     * asked for room.
     */
    it('is floored at the computed backoff, so clock skew cannot remove it', async () => {
      const operation = jest.fn()
        .mockRejectedValueOnce(new RateLimitError('slow down', { retryAfterMs: 0 }))
        .mockResolvedValue('ok')

      await expect(withRetry(operation, { baseDelayMs: 1_000, sleep: wait })).resolves.toBe('ok')
      expect(waits[0]).toBeGreaterThan(0)
    })
  })

  it('waits out the login floor a session manager reports', async () => {
    const operation = jest.fn()
      .mockRejectedValueOnce(new LoginThrottledError(3_000))
      .mockResolvedValue('ok')

    await expect(withRetry(operation, { baseDelayMs: 100, sleep: wait })).resolves.toBe('ok')
    expect(waits).toEqual([3_000])
  })

  it('computes a backoff for a rate limit that carried no Retry-After', async () => {
    const operation = jest.fn()
      .mockRejectedValueOnce(new RateLimitError('slow down'))
      .mockResolvedValue('ok')

    await expect(withRetry(operation, { baseDelayMs: 1_000, sleep: wait })).resolves.toBe('ok')
    expect(waits[0]).toBeGreaterThan(0)
    expect(waits[0]).not.toBe(7_500)
  })

  it('reports each retry to the caller so it can be logged', async () => {
    const onRetry = jest.fn()
    const error = new NetworkError('down')
    const operation = jest.fn().mockRejectedValueOnce(error).mockResolvedValue('ok')

    await withRetry(operation, { onRetry, sleep: wait })

    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Number), error)
  })

  it('honours a custom isRetryable predicate', async () => {
    const error = new ApiParseError('not json')
    const operation = jest.fn().mockRejectedValue(error)

    await expect(
      withRetry(operation, {
        sleep: wait,
        isRetryable: () => false,
      }),
    ).rejects.toThrow(ApiParseError)

    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('abandons a pending backoff when the caller aborts', async () => {
    const controller = new AbortController()
    const operation = jest.fn().mockRejectedValue(new NetworkError('down'))

    const pending = withRetry(operation, { baseDelayMs: 10_000, signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toThrow(OperationAbortedError)
    expect(operation).toHaveBeenCalledTimes(1)
  })
})

describe('sleep', () => {
  it('resolves after the requested delay', async () => {
    jest.useFakeTimers()
    try {
      let isDone = false
      const pending = sleep(50).then(() => {
        isDone = true
      })

      await jest.advanceTimersByTimeAsync(49)
      expect(isDone).toBe(false)

      await jest.advanceTimersByTimeAsync(1)
      await pending
      expect(isDone).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })

  it('rejects immediately when its signal has already aborted', async () => {
    await expect(sleep(50, AbortSignal.abort())).rejects.toThrow(OperationAbortedError)
  })

  it('rejects and clears its timer when the signal aborts mid-wait', async () => {
    const controller = new AbortController()

    const pending = sleep(60_000, controller.signal)
    controller.abort()

    await expect(pending).rejects.toThrow(OperationAbortedError)
  })

  /**
   * Backoff waits run to a minute, and the initial-discovery backoff to five.
   * An unreferenced timer is what stops a child bridge appearing to hang for
   * that long after Homebridge asks it to stop.
   */
  it('does not hold the event loop open', () => {
    jest.useFakeTimers()
    try {
      const unref = jest.fn()
      jest.spyOn(global, 'setTimeout').mockReturnValue({ unref } as unknown as NodeJS.Timeout)

      void sleep(60_000)

      expect(unref).toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })
})
