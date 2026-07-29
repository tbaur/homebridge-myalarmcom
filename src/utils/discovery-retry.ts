/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Retry policy for the platform's initial device discovery.
 */

import { AlarmComError, CircuitBreakerError } from '../errors'
import {
  INITIAL_DISCOVERY_RETRY_BASE_MS,
  INITIAL_DISCOVERY_RETRY_MAX_MS,
} from '../settings'
import { computeBackoffMs } from './retry'

/**
 * Delay before retrying initial discovery, or `null` if the failure is permanent.
 *
 * {@link CircuitBreakerError} is not retryable inside a single API call (fail-fast),
 * but at startup it means "wait for the reset" rather than abandon Ready forever.
 */
export function initialDiscoveryRetryDelayMs(error: unknown, attempt: number): number | null {
  if (error instanceof CircuitBreakerError) {
    return Math.max(error.retryAfterMs, INITIAL_DISCOVERY_RETRY_BASE_MS)
  }

  if (error instanceof AlarmComError && error.isRetryable) {
    return computeBackoffMs(
      attempt,
      INITIAL_DISCOVERY_RETRY_BASE_MS,
      INITIAL_DISCOVERY_RETRY_MAX_MS,
    )
  }

  return null
}
