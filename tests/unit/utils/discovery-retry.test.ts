/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 */

import {
  AuthenticationError,
  CircuitBreakerError,
  ConfigurationError,
  NetworkError,
} from '../../../src/errors'
import { INITIAL_DISCOVERY_RETRY_BASE_MS } from '../../../src/settings'
import { initialDiscoveryRetryDelayMs } from '../../../src/utils/discovery-retry'

describe('initialDiscoveryRetryDelayMs', () => {
  it('returns null for permanent credential and configuration failures', () => {
    expect(initialDiscoveryRetryDelayMs(new AuthenticationError(), 1)).toBeNull()
    expect(initialDiscoveryRetryDelayMs(new ConfigurationError('no system'), 1)).toBeNull()
  })

  it('returns a backoff delay for ordinary retryable failures', () => {
    const delayMs = initialDiscoveryRetryDelayMs(new NetworkError('socket hang up'), 1)

    expect(delayMs).toBeGreaterThan(0)
    expect(delayMs).toBeGreaterThanOrEqual(INITIAL_DISCOVERY_RETRY_BASE_MS * 0.75)
  })

  it('waits at least the breaker reset remaining time for an open circuit', () => {
    const error = new CircuitBreakerError(12_000)
    const delayMs = initialDiscoveryRetryDelayMs(error, 1)

    // retryAfterMs is Date-based, so allow 1ms of clock skew.
    expect(delayMs).toBeGreaterThanOrEqual(11_999)
    expect(delayMs).toBeLessThanOrEqual(12_000)
  })

  it('floors a nearly-elapsed breaker reset at the discovery base delay', () => {
    const error = new CircuitBreakerError(100)
    const delayMs = initialDiscoveryRetryDelayMs(error, 1)

    expect(delayMs).toBe(INITIAL_DISCOVERY_RETRY_BASE_MS)
  })
})
