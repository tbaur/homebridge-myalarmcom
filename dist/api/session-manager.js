"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Owns the lifetime of the Alarm.com session.
 *
 * Everything here exists to minimise how often the plugin logs in. Signing in
 * is the single request Alarm.com polices hardest, and a lockout costs the user
 * their alarm system's app access, not merely this integration. So a session is
 * held as long as it works, refreshed with a cheap keep-alive rather than a new
 * login, and re-established no more often than a hard floor allows.
 *
 * `authIntervalMinutes` therefore means "how long a session may go unverified
 * before a fresh login", not "how long before the session is thrown away". The
 * keep-alive is what does the verifying; without it counting, the keep-alive
 * would have no effect on login frequency at all, which is the entire reason it
 * exists.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionManager = void 0;
const errors_1 = require("../errors");
const settings_1 = require("../settings");
const retry_1 = require("../utils/retry");
const sanitizers_1 = require("../utils/sanitizers");
const auth_1 = require("./auth");
/**
 * Consecutive keep-alive transport failures before the session is discarded.
 *
 * A single network blip is inconclusive; repeated failures mean the cookies
 * are almost certainly dead and the next caller should re-authenticate.
 */
const KEEPALIVE_FAILURE_LIMIT = 3;
/**
 * Minimum gap after a *failed* sign-in before another is attempted.
 *
 * Much shorter than the full re-authentication floor, because a transient
 * failure should not lock the plugin out for the whole interval — but long
 * enough that a retry loop cannot turn one API call into a burst of logins.
 * Deliberately below the initial-discovery backoff so startup still paces
 * itself on that instead.
 */
const FAILED_LOGIN_FLOOR_MS = 3 * settings_1.MS_PER_SECOND;
/** Establishes, reuses, and refreshes the Alarm.com session. */
class SessionManager {
    #credentials;
    #sessionLifetimeMs;
    #log;
    #onSessionEstablished;
    #signal;
    #session = null;
    /** When the held session was last known good: a login or a keep-alive. */
    #sessionVerifiedAt = 0;
    #lastLoginAttempt = 0;
    /**
     * A credential failure that will not clear on its own.
     *
     * Held so the floor re-reports the real problem instead of masking a bad
     * password as a generic throttle, which would leave a user with nothing in
     * the log to act on after the single original error scrolled away.
     */
    #permanentFailure = null;
    /** In-flight login, so concurrent callers share one attempt. */
    #pendingLogin = null;
    /** Consecutive keep-alive transport failures against the current session. */
    #keepAliveFailures = 0;
    constructor(options) {
        this.#credentials = options.credentials;
        this.#sessionLifetimeMs = options.authIntervalMinutes * settings_1.MS_PER_MINUTE;
        this.#log = options.log;
        this.#onSessionEstablished = options.onSessionEstablished;
        this.#signal = options.signal;
    }
    /** Whether the current session has been verified recently enough to reuse. */
    #isFresh() {
        return Date.now() - this.#sessionVerifiedAt < this.#sessionLifetimeMs;
    }
    /**
     * Return a usable session, logging in only if necessary.
     *
     * Concurrent callers during a login all await the same attempt rather than
     * each starting their own, which would be both wasteful and the exact
     * pattern that trips abuse detection.
     */
    async getSession() {
        if (this.#session && this.#isFresh()) {
            return this.#session;
        }
        if (this.#pendingLogin) {
            return this.#pendingLogin;
        }
        this.#pendingLogin = this.#login();
        try {
            return await this.#pendingLogin;
        }
        finally {
            this.#pendingLogin = null;
        }
    }
    /**
     * Enforce the minimum gap between logins.
     *
     * A short remainder is simply waited out. A long one is refused: the floor
     * can be up to a day, and sleeping through it inside `getSession()` blocks
     * the poll cycle and any HomeKit arm/disarm queued behind it, with the
     * caller's in-flight guard held the whole time.
     *
     * @throws {AuthenticationError} The last attempt failed permanently.
     * @throws {LoginThrottledError} The remaining wait is too long to hold inline.
     */
    async #awaitLoginFloor() {
        if (this.#lastLoginAttempt === 0) {
            return;
        }
        const remainingMs = this.#sessionLifetimeMs - (Date.now() - this.#lastLoginAttempt);
        if (remainingMs <= 0) {
            return;
        }
        // Re-raise the real diagnosis rather than reporting a throttle. Nothing
        // about waiting longer fixes a rejected password, and the user needs to
        // keep seeing why.
        if (this.#permanentFailure) {
            throw this.#permanentFailure;
        }
        if (remainingMs > settings_1.MAX_LOGIN_FLOOR_WAIT_MS) {
            throw new errors_1.LoginThrottledError(remainingMs);
        }
        this.#log.debug(`deferring re-authentication for ${Math.round(remainingMs / settings_1.MS_PER_SECOND)}s to stay within the login floor`);
        await (0, retry_1.sleep)(remainingMs, this.#signal);
    }
    async #login() {
        // The floor applies after a successful sign-in or a permanent credential
        // rejection. Transient failures intentionally leave it alone so a boot-time
        // network blip can be retried on the discovery backoff instead.
        await this.#awaitLoginFloor();
        this.#log.debug('Signing in to Alarm.com');
        try {
            this.#session = await (0, auth_1.authenticate)(this.#credentials, this.#log, this.#signal);
            this.#lastLoginAttempt = Date.now();
            this.#sessionVerifiedAt = Date.now();
            this.#keepAliveFailures = 0;
            this.#permanentFailure = null;
            this.#log.debug('Alarm.com session established');
            this.#onSessionEstablished?.();
            return this.#session;
        }
        catch (error) {
            this.#session = null;
            this.#sessionVerifiedAt = 0;
            this.#keepAliveFailures = 0;
            // Even a transient failure stamps a short floor. Without it, nothing
            // paced re-login at runtime: a retryable failure let the next caller try
            // again immediately, and since sign-in bypasses the request rate limiter
            // that meant up to six login attempts per API call. Only the circuit
            // breaker bounded it, which is thin cover for the one operation Alarm.com
            // polices hardest. Startup is unaffected — the discovery backoff paces
            // that path, and this floor is shorter than its first retry.
            this.#lastLoginAttempt = Date.now() - (this.#sessionLifetimeMs - FAILED_LOGIN_FLOOR_MS);
            // These two are permanent until the user changes something. Say so
            // plainly, because the alternative is a log full of identical retries.
            // Stamp the full floor so we do not hammer Alarm.com with the same rejection.
            if (error instanceof errors_1.TwoFactorRequiredError) {
                this.#recordPermanentFailure(error, 'Alarm.com requires two-factor verification. Copy a fresh "twoFactorAuthenticationId" cookie from a signed-in browser into the plugin config.');
            }
            else if (error instanceof errors_1.AuthenticationError) {
                this.#recordPermanentFailure(error, 'Alarm.com rejected the configured credentials. Fix them before restarting; repeated failed sign-ins can lock the account.');
            }
            throw error;
        }
    }
    #recordPermanentFailure(error, guidance) {
        this.#lastLoginAttempt = Date.now();
        this.#permanentFailure = error;
        this.#log.error(guidance);
    }
    /**
     * Refresh the session without a full login.
     *
     * A success re-stamps the freshness clock, which is the whole point: without
     * that, the next login lands on the auth interval regardless of how healthy
     * the session is, and the keep-alive spends a request every few minutes
     * without ever preventing the operation it exists to prevent.
     *
     * @returns Whether a live session is still held afterwards.
     */
    async touch() {
        const session = this.#session;
        if (!session) {
            return false;
        }
        try {
            const isAlive = await (0, auth_1.keepAlive)(session, this.#signal);
            if (!isAlive) {
                this.#log.debug('keep-alive reported the session is no longer valid');
                // Only clear if this is still the session we probed. A concurrent
                // invalidate()+re-login can install a newer session while keep-alive
                // was in flight; wiping that would force another policed login.
                if (this.#session === session) {
                    this.#session = null;
                    this.#sessionVerifiedAt = 0;
                    this.#keepAliveFailures = 0;
                }
                return false;
            }
            if (this.#session === session) {
                this.#sessionVerifiedAt = Date.now();
                this.#keepAliveFailures = 0;
            }
            return true;
        }
        catch (error) {
            // Transport errors are inconclusive once; repeated failures against the
            // same session mean the cookies are almost certainly dead.
            if (this.#session !== session) {
                return false;
            }
            this.#keepAliveFailures++;
            // sanitizeError, not String: it walks the cause chain, and the actionable
            // half of a wrapped NetworkError is the ECONNREFUSED underneath it.
            this.#log.debug(`keep-alive failed (${this.#keepAliveFailures}/${KEEPALIVE_FAILURE_LIMIT}): ${(0, sanitizers_1.sanitizeError)(error)}`);
            if (this.#keepAliveFailures >= KEEPALIVE_FAILURE_LIMIT) {
                this.#log.warn('Alarm.com keep-alive failed repeatedly; discarding the session so the next request re-authenticates');
                this.#session = null;
                this.#sessionVerifiedAt = 0;
                this.#keepAliveFailures = 0;
            }
            return false;
        }
    }
    /** Discard the current session so the next call re-authenticates. */
    invalidate() {
        this.#session = null;
        this.#sessionVerifiedAt = 0;
        this.#keepAliveFailures = 0;
    }
    /** Whether a session is currently held. Does not trigger a login. */
    get hasSession() {
        return this.#session !== null;
    }
}
exports.SessionManager = SessionManager;
//# sourceMappingURL=session-manager.js.map