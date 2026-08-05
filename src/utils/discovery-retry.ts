/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Retry policy for the platform's initial device discovery.
 */

import {
  AlarmComError,
  AuthenticationError,
  CircuitBreakerError,
  ConfigurationError,
  LoginFormError,
} from '../errors'
import {
  INITIAL_DISCOVERY_RETRY_BASE_MS,
  INITIAL_DISCOVERY_RETRY_MAX_MS,
} from '../settings'
import { computeBackoffMs } from './retry'

/**
 * Whether a startup failure will still be there after any amount of waiting.
 *
 * Only failures that need a human: wrong credentials, an expired two-factor
 * cookie, a login page this plugin can no longer parse, or invalid config.
 * Everything else — including a 403, which Alarm.com hands out transiently —
 * gets retried, because giving up leaves a security integration silently dead
 * with no polling, no push updates, and one line in the log.
 */
function isPermanent(error: unknown): boolean {
  return error instanceof AuthenticationError
    || error instanceof LoginFormError
    || error instanceof ConfigurationError
}

/**
 * Delay before retrying initial discovery, or `null` if the failure is permanent.
 *
 * {@link CircuitBreakerError} is not retryable inside a single API call (fail-fast),
 * but at startup it means "wait for the reset" rather than abandon Ready forever.
 */
export function initialDiscoveryRetryDelayMs(error: unknown, attempt: number): number | null {
  if (isPermanent(error)) {
    return null
  }

  if (error instanceof CircuitBreakerError) {
    return Math.max(error.retryAfterMs, INITIAL_DISCOVERY_RETRY_BASE_MS)
  }

  if (error instanceof AlarmComError) {
    return computeBackoffMs(
      attempt,
      INITIAL_DISCOVERY_RETRY_BASE_MS,
      INITIAL_DISCOVERY_RETRY_MAX_MS,
    )
  }

  // Not one of ours: almost certainly a defect rather than a service condition,
  // and retrying a bug on a loop only buries the stack trace that explains it.
  return null
}
