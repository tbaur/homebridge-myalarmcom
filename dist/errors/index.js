"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Structured error hierarchy for predictable error handling.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CircuitBreakerError = exports.ApiParseError = exports.ApiResponseError = exports.RateLimitError = exports.TimeoutError = exports.NetworkError = exports.SystemUnavailableError = exports.ReadOnlyPartitionError = exports.ForbiddenError = exports.OperationAbortedError = exports.RequestPacingError = exports.LoginThrottledError = exports.SessionExpiredError = exports.LoginFormError = exports.TwoFactorRequiredError = exports.AuthenticationError = exports.ConfigurationError = exports.AlarmComError = void 0;
exports.parseRetryAfterMs = parseRetryAfterMs;
exports.createApiError = createApiError;
const settings_1 = require("../settings");
/**
 * Base class for all plugin errors.
 *
 * Carries a stable machine-readable `code` and an `isRetryable` hint so callers
 * can make retry decisions without string-matching messages — which matters
 * here because Alarm.com's own error text is inconsistent and unversioned.
 *
 * `isRetryable` means "this may clear on its own, so a later attempt is
 * worthwhile". It does *not* mean "safe for {@link withRetry} to hammer": some
 * retryable failures have a dedicated recovery path instead, and the client
 * excludes those explicitly rather than reinterpreting this flag.
 */
class AlarmComError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = this.constructor.name;
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }
}
exports.AlarmComError = AlarmComError;
/** Configuration is missing or invalid; not recoverable without user action. */
class ConfigurationError extends AlarmComError {
    code = 'CONFIG_ERROR';
    isRetryable = false;
}
exports.ConfigurationError = ConfigurationError;
/** Credentials were rejected. Retrying with the same credentials cannot help. */
class AuthenticationError extends AlarmComError {
    code = 'AUTH_ERROR';
    isRetryable = false;
    constructor(message = 'Authentication failed', options) {
        super(message, options);
    }
}
exports.AuthenticationError = AuthenticationError;
/**
 * Alarm.com demanded two-factor verification for this session.
 *
 * Surfaces as `409` with a `TwoFactorAuthenticationRequired` body. The user's
 * `twoFactorAuthenticationId` cookie is missing, expired, or was issued to a
 * different account. Never retried: repeated login attempts against a 2FA
 * challenge are exactly what gets an Alarm.com account locked.
 */
class TwoFactorRequiredError extends AuthenticationError {
    code = 'TWO_FACTOR_REQUIRED';
    constructor(message = 'Alarm.com requires two-factor verification; the configured twoFactorAuthenticationId cookie is missing or no longer valid', options) {
        super(message, options);
    }
}
exports.TwoFactorRequiredError = TwoFactorRequiredError;
/**
 * The login page did not yield the hidden WebForms fields needed to post.
 *
 * Alarm.com has no API contract, so a redesign of its login page breaks
 * authentication here first. Distinguished from a credential rejection because
 * the remedy is a plugin update, not a password change.
 */
class LoginFormError extends AlarmComError {
    code = 'LOGIN_FORM_ERROR';
    isRetryable = false;
    constructor(message = 'Could not parse the Alarm.com login form; the site layout may have changed', options) {
        super(message, options);
    }
}
exports.LoginFormError = LoginFormError;
/**
 * The session cookies are no longer accepted and a fresh login is needed.
 *
 * Retryable, but only through the session manager, which enforces the
 * re-authentication floor rather than logging in on demand.
 */
class SessionExpiredError extends AlarmComError {
    code = 'SESSION_EXPIRED';
    isRetryable = true;
}
exports.SessionExpiredError = SessionExpiredError;
/**
 * A re-login was needed but the re-authentication floor has not elapsed.
 *
 * Signing in is the request Alarm.com polices hardest, so the session manager
 * refuses to do it more often than the configured interval. Waiting out that
 * floor inline would block the poll cycle — and any HomeKit arm/disarm queued
 * behind it — for up to a day, so the caller is told to come back instead.
 */
class LoginThrottledError extends AlarmComError {
    code = 'LOGIN_THROTTLED';
    isRetryable = true;
    /** Milliseconds remaining before a login would be permitted. */
    retryAfterMs;
    constructor(retryAfterMs, options) {
        super(`Re-authentication is deferred for another ${Math.round(retryAfterMs / settings_1.MS_PER_SECOND)}s to stay within the Alarm.com login floor`, options);
        this.retryAfterMs = retryAfterMs;
    }
}
exports.LoginThrottledError = LoginThrottledError;
/**
 * Client-side pacing refused the request: the required wait was too long.
 *
 * Self-inflicted and self-healing, so it is neither a network failure nor an
 * Alarm.com error. It has its own type because the client has to tell it apart
 * from a real failure to keep latency percentiles and throttle counts honest,
 * and matching on the message text is exactly what this hierarchy exists to
 * avoid.
 */
class RequestPacingError extends AlarmComError {
    code = 'REQUEST_PACING';
    isRetryable = false;
    constructor(requiredWaitMs, maxWaitMs, options) {
        super(`Request pacing would require waiting ${requiredWaitMs}ms, exceeding the ${maxWaitMs}ms limit`, options);
    }
}
exports.RequestPacingError = RequestPacingError;
/** A wait or in-flight operation was cancelled, normally because of shutdown. */
class OperationAbortedError extends AlarmComError {
    code = 'OPERATION_ABORTED';
    isRetryable = false;
    constructor(message = 'Operation aborted', options) {
        super(message, options);
    }
}
exports.OperationAbortedError = OperationAbortedError;
/** Authenticated but not permitted (403). Re-authenticating cannot fix it. */
class ForbiddenError extends AlarmComError {
    code = 'FORBIDDEN_ERROR';
    isRetryable = false;
}
exports.ForbiddenError = ForbiddenError;
/**
 * The account may read the panel but not change its arming state.
 *
 * Alarm.com exposes this as `hasPermissionToChangeState: false`, so it is
 * detectable before a command is sent rather than only after it fails.
 */
class ReadOnlyPartitionError extends AlarmComError {
    code = 'READ_ONLY_PARTITION';
    isRetryable = false;
    constructor(partitionName, options) {
        super(`The Alarm.com account used cannot change the arming state of "${partitionName}"`, options);
    }
}
exports.ReadOnlyPartitionError = ReadOnlyPartitionError;
/**
 * Alarm.com did not report a usable system for this account.
 *
 * Usually an account provisioning problem, but the same shape arrives from a
 * truncated or partial response, so it is treated as something that may clear
 * rather than as a permanent end to startup. Deliberately not a
 * {@link ConfigurationError}: that means the *user's* config is wrong, and
 * telling someone to fix a setting they do not have is worse than saying
 * nothing.
 */
class SystemUnavailableError extends AlarmComError {
    code = 'SYSTEM_UNAVAILABLE';
    isRetryable = true;
}
exports.SystemUnavailableError = SystemUnavailableError;
/** Network-level failure (DNS, connection reset, etc.). Safe to retry. */
class NetworkError extends AlarmComError {
    code = 'NETWORK_ERROR';
    isRetryable = true;
}
exports.NetworkError = NetworkError;
/** Request exceeded the configured timeout. Safe to retry. */
class TimeoutError extends AlarmComError {
    code = 'TIMEOUT_ERROR';
    isRetryable = true;
}
exports.TimeoutError = TimeoutError;
/** Rate limited by Alarm.com (429). Retryable with backoff. */
class RateLimitError extends AlarmComError {
    code = 'RATE_LIMIT_ERROR';
    isRetryable = true;
    /** Server-suggested wait from `Retry-After`, when present. */
    retryAfterMs;
    constructor(message, options) {
        super(message, options?.cause ? { cause: options.cause } : undefined);
        this.retryAfterMs = options?.retryAfterMs;
    }
}
exports.RateLimitError = RateLimitError;
/** Non-2xx response that isn't auth or rate limiting. Retryable only for 5xx. */
class ApiResponseError extends AlarmComError {
    code = 'API_RESPONSE_ERROR';
    isRetryable;
    /** The status Alarm.com returned, for the retry classification below. */
    status;
    constructor(status, message, options) {
        super(message, options);
        this.status = status;
        this.isRetryable = status >= 500;
    }
}
exports.ApiResponseError = ApiResponseError;
/**
 * Response body could not be parsed as expected.
 *
 * Usually an HTML login page or interstitial served where JSON was expected,
 * which is Alarm.com's habit when a session has gone stale. Retryable, because
 * a single bad payload should not permanently stop polling.
 */
class ApiParseError extends AlarmComError {
    code = 'API_PARSE_ERROR';
    isRetryable = true;
}
exports.ApiParseError = ApiParseError;
/**
 * Circuit breaker is open; Alarm.com is being treated as unavailable.
 * Not retryable: callers should fail fast until {@link CircuitBreakerError.retryAfterMs}
 * elapses rather than burning paced attempts against a known-open circuit.
 */
class CircuitBreakerError extends AlarmComError {
    code = 'CIRCUIT_OPEN';
    isRetryable = false;
    resetTime;
    constructor(resetTimeMs, options) {
        const resetTime = new Date(Date.now() + resetTimeMs);
        super(`Circuit breaker is open. Service unavailable until ${resetTime.toISOString()}`, options);
        this.resetTime = resetTime;
    }
    get retryAfterMs() {
        return Math.max(0, this.resetTime.getTime() - Date.now());
    }
}
exports.CircuitBreakerError = CircuitBreakerError;
/** Marker Alarm.com returns in a 409 body when it wants two-factor verification. */
const TWO_FACTOR_MARKER = 'twofactorauthenticationrequired';
/**
 * Parse an HTTP `Retry-After` value into a millisecond delay.
 *
 * Accepts either a delay in seconds or an HTTP-date. Invalid values are ignored
 * so callers fall back to computed backoff.
 *
 * Deliberately unbounded: this reports what the server said, nothing more. The
 * value is remote-controlled and an HTTP-date is subject to clock skew, so
 * callers must both floor it (a skewed date can parse to `0`) and cap it
 * (`Retry-After: 86400` is a day) before sleeping on it.
 */
function parseRetryAfterMs(header) {
    if (!header) {
        return undefined;
    }
    const trimmed = header.trim();
    if (!trimmed) {
        return undefined;
    }
    const asSeconds = Number(trimmed);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
        return Math.round(asSeconds * settings_1.MS_PER_SECOND);
    }
    const asDate = Date.parse(trimmed);
    if (!Number.isNaN(asDate)) {
        return Math.max(0, asDate - Date.now());
    }
    return undefined;
}
/**
 * Map an HTTP status and body to the appropriate error type.
 *
 * The body is inspected only for the 409 case, where the status alone does not
 * distinguish a two-factor challenge from an ordinary conflict.
 */
function createApiError(status, message, options) {
    const cause = options?.cause ? { cause: options.cause } : undefined;
    if (status === 401) {
        return new SessionExpiredError(message, cause);
    }
    if (status === 409 && options?.body?.toLowerCase().includes(TWO_FACTOR_MARKER)) {
        return new TwoFactorRequiredError(message, cause);
    }
    if (status === 403) {
        return new ForbiddenError(message, cause);
    }
    if (status === 429) {
        return new RateLimitError(message, {
            ...cause,
            ...(options?.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
        });
    }
    return new ApiResponseError(status, message, cause);
}
//# sourceMappingURL=index.js.map