/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Retry with exponential backoff and jitter.
 */

import { AlarmComError, LoginThrottledError, OperationAbortedError, RateLimitError } from '../errors'
import { MAX_API_RETRY_ATTEMPTS, MAX_RETRY_BACKOFF_MS } from '../settings'

/** Tuning for {@link withRetry}. */
export interface RetryOptions {
  /** Total attempts including the first. */
  maxAttempts?: number
  /** Delay before the second attempt, doubled each time after. */
  baseDelayMs?: number
  /** Ceiling on any single delay, including a server-supplied `Retry-After`. */
  maxDelayMs?: number
  /** Called before each wait, for logging. */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void
  /** Injectable sleep, so tests need not wait in real time. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Override which errors are worth another attempt. */
  isRetryable?: (error: unknown) => boolean
  /** Abandons the retry loop, and any wait in progress, on shutdown. */
  signal?: AbortSignal
}

const DEFAULT_BASE_DELAY_MS = 1_000

/**
 * How far either side of the computed delay the jitter may reach.
 *
 * Named because the docblock on {@link computeBackoffMs} already refers to it.
 */
const JITTER_FACTOR = 0.25

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
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted === true) {
    return Promise.reject(new OperationAbortedError('Wait cancelled before it started'))
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()

    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new OperationAbortedError('Wait cancelled'))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Compute the delay before a given attempt.
 *
 * Exponential growth, capped, with up to ±25% jitter. The jitter matters
 * because several Homebridge instances behind one Alarm.com account would
 * otherwise retry in lockstep and look exactly like an attack.
 */
export function computeBackoffMs(
  attempt: number,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxDelayMs = MAX_RETRY_BACKOFF_MS,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)
  const jitter = (random() * 2 - 1) * exponential * JITTER_FACTOR
  // Clamped after jitter, not before. Applying the cap first and then adding up
  // to +25% let the delay sit a quarter above the ceiling that `resolveDelayMs`
  // refuses a *server* hint for exceeding.
  return Math.min(maxDelayMs, Math.max(0, Math.round(exponential + jitter)))
}

/** Whether a thrown value is worth another attempt. */
function isRetryable(error: unknown): boolean {
  return error instanceof AlarmComError && error.isRetryable
}

/**
 * A wait the server asked for, if it asked for one.
 *
 * Both {@link RateLimitError} and {@link LoginThrottledError} carry a deadline
 * the plugin should respect rather than guess at.
 */
function serverRequestedDelayMs(error: unknown): number | undefined {
  if (error instanceof RateLimitError) {
    return error.retryAfterMs
  }
  if (error instanceof LoginThrottledError) {
    return error.retryAfterMs
  }
  return undefined
}

/**
 * Reconcile a server-requested wait with the computed backoff.
 *
 * A server hint is respected but not obeyed blindly. It is remote-controlled
 * and, for an HTTP-date, subject to clock skew, so it is bounded on both sides:
 *
 * - Floored at the computed backoff, because a skewed date parses to `0` and
 *   would otherwise retry instantly against a service that just said slow down.
 * - Capped at `maxDelayMs`, returning `null` beyond it. A `Retry-After: 86400`
 *   is not a wait to sleep through inside a poll cycle — that holds the cycle's
 *   in-flight flag for a day and silently stops all polling.
 */
function resolveDelayMs(
  error: unknown,
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number | null {
  const backoffMs = computeBackoffMs(attempt, baseDelayMs, maxDelayMs)
  const serverDelayMs = serverRequestedDelayMs(error)

  if (serverDelayMs === undefined) {
    return backoffMs
  }
  if (serverDelayMs > maxDelayMs) {
    return null
  }
  return Math.max(serverDelayMs, backoffMs)
}

/**
 * Run an operation, retrying retryable failures with backoff.
 *
 * Only errors that declare themselves retryable are retried; everything else
 * propagates immediately. A `Retry-After` from Alarm.com wins over the computed
 * backoff within the configured ceiling, since arguing with a rate limiter is
 * how accounts get locked; beyond the ceiling the retry is abandoned so the
 * caller's own schedule can decide when to try again.
 *
 * @param operation Must be idempotent. Do not wrap arming commands in this.
 * @throws {OperationAbortedError} `options.signal` aborted during a wait.
 */
/**
 * Numeric defaults only.
 *
 * `sleep` and `isRetryable` stay resolved at call time below: capturing them
 * here would freeze the binding at module load, and both are seams that tests
 * replace afterwards.
 */
const RETRY_DEFAULTS = {
  maxAttempts: MAX_API_RETRY_ATTEMPTS,
  baseDelayMs: DEFAULT_BASE_DELAY_MS,
  maxDelayMs: MAX_RETRY_BACKOFF_MS,
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  // Numeric defaults merged rather than destructured one by one: as inline
  // defaults they dominated this function's measured complexity while saying
  // nothing about what it does. `exactOptionalPropertyTypes` stops a caller
  // passing an explicit `undefined`, so a spread cannot erase a default.
  const { maxAttempts, baseDelayMs, maxDelayMs, onRetry, signal } = {
    ...RETRY_DEFAULTS,
    ...options,
  }
  const wait = options.sleep ?? sleep
  const shouldRetry = options.isRetryable ?? isRetryable

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      if (!shouldRetry(error) || attempt >= maxAttempts) {
        throw error
      }

      const delayMs = resolveDelayMs(error, attempt, baseDelayMs, maxDelayMs)
      if (delayMs === null) {
        throw error
      }

      onRetry?.(attempt, delayMs, error)
      await wait(delayMs, signal)
    }
  }
}
