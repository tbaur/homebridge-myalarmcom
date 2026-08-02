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
  ForbiddenError,
  NetworkError,
} from '../../../src/errors'
import { failureLogLevel } from '../../../src/utils/failure-log-level'

describe('failureLogLevel', () => {
  it('keeps open-circuit failures at debug so polls do not ERROR-spam', () => {
    expect(failureLogLevel(new CircuitBreakerError(30_000))).toBe('debug')
  })

  it('keeps 403s at debug; the circuit breaker surfaces sustained denials', () => {
    expect(
      failureLogLevel(new ForbiddenError('Alarm.com returned 403 for https://www.alarm.com/web/api/devices/partitions')),
    ).toBe('debug')
  })

  it('keeps ordinary retryable failures at debug', () => {
    expect(failureLogLevel(new NetworkError('socket hang up'))).toBe('debug')
  })

  it('surfaces permanent credential and configuration failures at error', () => {
    expect(failureLogLevel(new AuthenticationError())).toBe('error')
    expect(failureLogLevel(new ConfigurationError('no system'))).toBe('error')
  })

  it('surfaces unknown failures at error', () => {
    expect(failureLogLevel(new Error('boom'))).toBe('error')
  })
})
