/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Structured error hierarchy for predictable error handling.
 */
/**
 * Every machine-readable error code the plugin can produce.
 *
 * A closed union rather than `string` so a comparison against a code that no
 * longer exists is a compile error instead of a branch that silently stops
 * matching.
 */
export type ErrorCode = 'CONFIG_ERROR' | 'AUTH_ERROR' | 'TWO_FACTOR_REQUIRED' | 'LOGIN_FORM_ERROR' | 'LOGIN_THROTTLED' | 'SESSION_EXPIRED' | 'FORBIDDEN_ERROR' | 'READ_ONLY_PARTITION' | 'SYSTEM_UNAVAILABLE' | 'NETWORK_ERROR' | 'TIMEOUT_ERROR' | 'RATE_LIMIT_ERROR' | 'REQUEST_PACING' | 'API_RESPONSE_ERROR' | 'API_PARSE_ERROR' | 'CIRCUIT_OPEN' | 'OPERATION_ABORTED';
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
export declare abstract class AlarmComError extends Error {
    abstract readonly code: ErrorCode;
    abstract readonly isRetryable: boolean;
    constructor(message: string, options?: {
        cause?: Error;
    });
}
/** Configuration is missing or invalid; not recoverable without user action. */
export declare class ConfigurationError extends AlarmComError {
    readonly code = "CONFIG_ERROR";
    readonly isRetryable = false;
}
/** Credentials were rejected. Retrying with the same credentials cannot help. */
export declare class AuthenticationError extends AlarmComError {
    readonly code: ErrorCode;
    readonly isRetryable = false;
    constructor(message?: string, options?: {
        cause?: Error;
    });
}
/**
 * Alarm.com demanded two-factor verification for this session.
 *
 * Surfaces as `409` with a `TwoFactorAuthenticationRequired` body. The user's
 * `twoFactorAuthenticationId` cookie is missing, expired, or was issued to a
 * different account. Never retried: repeated login attempts against a 2FA
 * challenge are exactly what gets an Alarm.com account locked.
 */
export declare class TwoFactorRequiredError extends AuthenticationError {
    readonly code: ErrorCode;
    constructor(message?: string, options?: {
        cause?: Error;
    });
}
/**
 * The login page did not yield the hidden WebForms fields needed to post.
 *
 * Alarm.com has no API contract, so a redesign of its login page breaks
 * authentication here first. Distinguished from a credential rejection because
 * the remedy is a plugin update, not a password change.
 */
export declare class LoginFormError extends AlarmComError {
    readonly code = "LOGIN_FORM_ERROR";
    readonly isRetryable = false;
    constructor(message?: string, options?: {
        cause?: Error;
    });
}
/**
 * The session cookies are no longer accepted and a fresh login is needed.
 *
 * Retryable, but only through the session manager, which enforces the
 * re-authentication floor rather than logging in on demand.
 */
export declare class SessionExpiredError extends AlarmComError {
    readonly code = "SESSION_EXPIRED";
    readonly isRetryable = true;
}
/**
 * A re-login was needed but the re-authentication floor has not elapsed.
 *
 * Signing in is the request Alarm.com polices hardest, so the session manager
 * refuses to do it more often than the configured interval. Waiting out that
 * floor inline would block the poll cycle — and any HomeKit arm/disarm queued
 * behind it — for up to a day, so the caller is told to come back instead.
 */
export declare class LoginThrottledError extends AlarmComError {
    readonly code = "LOGIN_THROTTLED";
    readonly isRetryable = true;
    /** Milliseconds remaining before a login would be permitted. */
    readonly retryAfterMs: number;
    constructor(retryAfterMs: number, options?: {
        cause?: Error;
    });
}
/**
 * Client-side pacing refused the request: the required wait was too long.
 *
 * Self-inflicted and self-healing, so it is neither a network failure nor an
 * Alarm.com error. It has its own type because the client has to tell it apart
 * from a real failure to keep latency percentiles and throttle counts honest,
 * and matching on the message text is exactly what this hierarchy exists to
 * avoid.
 */
export declare class RequestPacingError extends AlarmComError {
    readonly code = "REQUEST_PACING";
    readonly isRetryable = false;
    constructor(requiredWaitMs: number, maxWaitMs: number, options?: {
        cause?: Error;
    });
}
/** A wait or in-flight operation was cancelled, normally because of shutdown. */
export declare class OperationAbortedError extends AlarmComError {
    readonly code = "OPERATION_ABORTED";
    readonly isRetryable = false;
    constructor(message?: string, options?: {
        cause?: Error;
    });
}
/** Authenticated but not permitted (403). Re-authenticating cannot fix it. */
export declare class ForbiddenError extends AlarmComError {
    readonly code = "FORBIDDEN_ERROR";
    readonly isRetryable = false;
}
/**
 * The account may read the panel but not change its arming state.
 *
 * Alarm.com exposes this as `hasPermissionToChangeState: false`, so it is
 * detectable before a command is sent rather than only after it fails.
 */
export declare class ReadOnlyPartitionError extends AlarmComError {
    readonly code = "READ_ONLY_PARTITION";
    readonly isRetryable = false;
    constructor(partitionName: string, options?: {
        cause?: Error;
    });
}
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
export declare class SystemUnavailableError extends AlarmComError {
    readonly code = "SYSTEM_UNAVAILABLE";
    readonly isRetryable = true;
}
/** Network-level failure (DNS, connection reset, etc.). Safe to retry. */
export declare class NetworkError extends AlarmComError {
    readonly code = "NETWORK_ERROR";
    readonly isRetryable = true;
}
/** Request exceeded the configured timeout. Safe to retry. */
export declare class TimeoutError extends AlarmComError {
    readonly code = "TIMEOUT_ERROR";
    readonly isRetryable = true;
}
/** Rate limited by Alarm.com (429). Retryable with backoff. */
export declare class RateLimitError extends AlarmComError {
    readonly code = "RATE_LIMIT_ERROR";
    readonly isRetryable = true;
    /** Server-suggested wait from `Retry-After`, when present. */
    readonly retryAfterMs: number | undefined;
    constructor(message: string, options?: {
        cause?: Error;
        retryAfterMs?: number;
    });
}
/** Non-2xx response that isn't auth or rate limiting. Retryable only for 5xx. */
export declare class ApiResponseError extends AlarmComError {
    readonly code = "API_RESPONSE_ERROR";
    readonly isRetryable: boolean;
    /** The status Alarm.com returned, for the retry classification below. */
    readonly status: number;
    constructor(status: number, message: string, options?: {
        cause?: Error;
    });
}
/**
 * Response body could not be parsed as expected.
 *
 * Usually an HTML login page or interstitial served where JSON was expected,
 * which is Alarm.com's habit when a session has gone stale. Retryable, because
 * a single bad payload should not permanently stop polling.
 */
export declare class ApiParseError extends AlarmComError {
    readonly code = "API_PARSE_ERROR";
    readonly isRetryable = true;
}
/**
 * Circuit breaker is open; Alarm.com is being treated as unavailable.
 * Not retryable: callers should fail fast until {@link CircuitBreakerError.retryAfterMs}
 * elapses rather than burning paced attempts against a known-open circuit.
 */
export declare class CircuitBreakerError extends AlarmComError {
    readonly code = "CIRCUIT_OPEN";
    readonly isRetryable = false;
    readonly resetTime: Date;
    constructor(resetTimeMs: number, options?: {
        cause?: Error;
    });
    get retryAfterMs(): number;
}
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
export declare function parseRetryAfterMs(header: string | null | undefined): number | undefined;
/**
 * Map an HTTP status and body to the appropriate error type.
 *
 * The body is inspected only for the 409 case, where the status alone does not
 * distinguish a two-factor challenge from an ordinary conflict.
 */
export declare function createApiError(status: number, message: string, options?: {
    body?: string;
    cause?: Error;
    retryAfterMs?: number;
}): AlarmComError;
//# sourceMappingURL=index.d.ts.map