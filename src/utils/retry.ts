/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Retry with exponential backoff and jitter.
 */

import { AlarmComError, RateLimitError } from '../errors'
import { MAX_API_RETRY_ATTEMPTS, MAX_RETRY_BACKOFF_MS } from '../settings'

/** Tuning for {@link withRetry}. */
export interface RetryOptions {
  /** Total attempts including the first. */
  maxAttempts?: number
  /** Delay before the second attempt, doubled each time after. */
  baseDelayMs?: number
  /** Ceiling on any single delay. */
  maxDelayMs?: number
  /** Called before each wait, for logging. */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void
  /** Injectable sleep, so tests need not wait in real time. */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_BASE_DELAY_MS = 1_000

/** Resolve after the given delay. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

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
  const jitterRange = exponential * 0.25
  const jitter = (random() * 2 - 1) * jitterRange
  return Math.max(0, Math.round(exponential + jitter))
}

/** Whether a thrown value is worth another attempt. */
function isRetryable(error: unknown): boolean {
  return error instanceof AlarmComError && error.isRetryable
}

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
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = MAX_API_RETRY_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = MAX_RETRY_BACKOFF_MS,
    onRetry,
    sleep: wait = sleep,
  } = options

  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error

      if (!isRetryable(error) || attempt === maxAttempts) {
        throw error
      }

      const serverDelay = error instanceof RateLimitError ? error.retryAfterMs : undefined
      const delayMs = serverDelay ?? computeBackoffMs(attempt, baseDelayMs, maxDelayMs)

      onRetry?.(attempt, delayMs, error)
      await wait(delayMs)
    }
  }

  throw lastError
}
