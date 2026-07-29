/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Retry decisions are taken from the `isRetryable` flag rather than from error
 * text, so the mapping from an HTTP status to an error class is load-bearing.
 */

import {
  AlarmComError,
  ApiParseError,
  ApiResponseError,
  AuthenticationError,
  CircuitBreakerError,
  createApiError,
  ForbiddenError,
  RateLimitError,
  ReadOnlyPartitionError,
  SessionExpiredError,
  TwoFactorRequiredError,
} from '../../../src/errors'

describe('createApiError', () => {
  it('maps 401 to an expired session, which the session manager can recover from', () => {
    const error = createApiError(401, 'Alarm.com returned 401')

    expect(error).toBeInstanceOf(SessionExpiredError)
    expect(error.code).toBe('SESSION_EXPIRED')
    expect(error.isRetryable).toBe(true)
  })

  it('maps 403 to a permission failure that re-authenticating cannot fix', () => {
    const error = createApiError(403, 'Alarm.com returned 403')

    expect(error).toBeInstanceOf(ForbiddenError)
    expect(error.isRetryable).toBe(false)
    expect(error.httpStatus).toBe(403)
  })

  it('maps 429 to a rate limit that is worth retrying', () => {
    const error = createApiError(429, 'Alarm.com returned 429')

    expect(error).toBeInstanceOf(RateLimitError)
    expect(error.isRetryable).toBe(true)
    expect(error.httpStatus).toBe(429)
  })

  it('maps 5xx to a retryable response error', () => {
    for (const status of [500, 502, 503]) {
      const error = createApiError(status, `Alarm.com returned ${status}`)

      expect(error).toBeInstanceOf(ApiResponseError)
      expect(error.isRetryable).toBe(true)
      expect(error.httpStatus).toBe(status)
    }
  })

  it('maps other 4xx to a response error that is not worth retrying', () => {
    const error = createApiError(404, 'Alarm.com returned 404')

    expect(error).toBeInstanceOf(ApiResponseError)
    expect(error.isRetryable).toBe(false)
  })

  describe('the 409 conflict, which Alarm.com overloads', () => {
    it('is a two-factor challenge when the body says so', () => {
      const error = createApiError(409, 'Alarm.com returned 409', {
        body: '{"errors":[{"code":"TwoFactorAuthenticationRequired"}]}',
      })

      expect(error).toBeInstanceOf(TwoFactorRequiredError)
      expect(error.isRetryable).toBe(false)
    })

    it('matches the marker regardless of case', () => {
      const error = createApiError(409, 'conflict', { body: 'twofactorauthenticationrequired' })

      expect(error).toBeInstanceOf(TwoFactorRequiredError)
    })

    it('is an ordinary conflict when the body does not mention two-factor', () => {
      const error = createApiError(409, 'Alarm.com returned 409', { body: '{"errors":["Conflict"]}' })

      expect(error).toBeInstanceOf(ApiResponseError)
      expect(error).not.toBeInstanceOf(TwoFactorRequiredError)
    })

    it('is an ordinary conflict when no body was captured', () => {
      expect(createApiError(409, 'Alarm.com returned 409')).toBeInstanceOf(ApiResponseError)
    })
  })

  it('keeps the underlying cause for debugging', () => {
    const cause = new Error('socket hang up')

    expect(createApiError(500, 'boom', { cause }).cause).toBe(cause)
  })
})

describe('AlarmComError', () => {
  it('serialises to something structured enough to log', () => {
    const error = createApiError(503, 'Alarm.com returned 503')
    const json = error.toJSON()

    expect(json).toMatchObject({
      name: 'ApiResponseError',
      code: 'API_RESPONSE_ERROR',
      message: 'Alarm.com returned 503',
      isRetryable: true,
      httpStatus: 503,
    })
    expect(typeof json.timestamp).toBe('string')
  })

  it('names itself after its own class', () => {
    expect(new ApiParseError('unparseable').name).toBe('ApiParseError')
    expect(new ApiParseError('unparseable')).toBeInstanceOf(AlarmComError)
  })
})

describe('TwoFactorRequiredError', () => {
  it('is an authentication failure, so callers handling those catch it too', () => {
    expect(new TwoFactorRequiredError()).toBeInstanceOf(AuthenticationError)
  })

  it('explains the remedy by default', () => {
    expect(new TwoFactorRequiredError().message).toMatch(/twoFactorAuthenticationId/)
  })
})

describe('RateLimitError', () => {
  it('carries the server-suggested wait when one was supplied', () => {
    expect(new RateLimitError('slow down', { retryAfterMs: 5_000 }).retryAfterMs).toBe(5_000)
    expect(new RateLimitError('slow down').retryAfterMs).toBeUndefined()
  })
})

describe('ReadOnlyPartitionError', () => {
  it('names the partition the account may not control', () => {
    expect(new ReadOnlyPartitionError('Home').message)
      .toBe('The Alarm.com account does not have permission to change the arming state of "Home"')
  })
})

describe('CircuitBreakerError', () => {
  it('reports how long is left before the service is probed again', () => {
    const error = new CircuitBreakerError(30_000)

    expect(error.retryAfterMs).toBeGreaterThan(29_000)
    expect(error.retryAfterMs).toBeLessThanOrEqual(30_000)
    expect(error.message).toMatch(/Circuit breaker is open/)
  })

  it('never reports a negative wait once the reset time has passed', () => {
    expect(new CircuitBreakerError(-1_000).retryAfterMs).toBe(0)
  })
})
