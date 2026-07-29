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
 */

import { AuthenticationError, TwoFactorRequiredError } from '../errors'
import type { Logger } from '../utils/logger'
import { sleep } from '../utils/retry'
import { authenticate, keepAlive, type Credentials, type Session } from './auth'

export interface SessionManagerOptions {
  credentials: Credentials
  /** Session lifetime before a proactive re-login, in minutes. */
  authIntervalMinutes: number
  log: Logger
  /** Called after a successful sign-in, for diagnostics. */
  onSessionEstablished?: () => void
}

/**
 * Consecutive keep-alive transport failures before the session is discarded.
 *
 * A single network blip is inconclusive; repeated failures mean the cookies
 * are almost certainly dead and the next caller should re-authenticate.
 */
const KEEPALIVE_FAILURE_LIMIT = 3

/** Establishes, reuses, and refreshes the Alarm.com session. */
export class SessionManager {
  readonly #credentials: Credentials
  readonly #sessionLifetimeMs: number
  readonly #log: Logger
  readonly #onSessionEstablished?: () => void

  #session: Session | null = null
  #lastLoginAttempt = 0
  /** In-flight login, so concurrent callers share one attempt. */
  #pendingLogin: Promise<Session> | null = null
  /** Consecutive keep-alive transport failures against the current session. */
  #keepAliveFailures = 0

  constructor(options: SessionManagerOptions) {
    this.#credentials = options.credentials
    this.#sessionLifetimeMs = options.authIntervalMinutes * 60_000
    this.#log = options.log
    this.#onSessionEstablished = options.onSessionEstablished
  }

  /** Whether the current session is still within its configured lifetime. */
  #isFresh(session: Session): boolean {
    return Date.now() - session.createdAt.getTime() < this.#sessionLifetimeMs
  }

  /**
   * Return a usable session, logging in only if necessary.
   *
   * Concurrent callers during a login all await the same attempt rather than
   * each starting their own, which would be both wasteful and the exact
   * pattern that trips abuse detection.
   */
  async getSession(): Promise<Session> {
    if (this.#session && this.#isFresh(this.#session)) {
      return this.#session
    }

    if (this.#pendingLogin) {
      return this.#pendingLogin
    }

    this.#pendingLogin = this.#login()

    try {
      return await this.#pendingLogin
    } finally {
      this.#pendingLogin = null
    }
  }

  async #login(): Promise<Session> {
    // Never allow logins closer together than the configured lifetime after a
    // successful sign-in (or a permanent credential rejection). Transient
    // failures intentionally leave the floor alone so a boot-time network blip
    // can be retried on the discovery backoff rather than waiting ten minutes.
    const sinceLastAttempt = Date.now() - this.#lastLoginAttempt
    if (this.#lastLoginAttempt > 0 && sinceLastAttempt < this.#sessionLifetimeMs) {
      const waitMs = this.#sessionLifetimeMs - sinceLastAttempt
      this.#log.debug(`deferring re-authentication for ${Math.round(waitMs / 1000)}s to stay within the login floor`)
      await sleep(waitMs)
    }

    this.#log.debug('Signing in to Alarm.com')

    try {
      this.#session = await authenticate(this.#credentials, this.#log)
      this.#lastLoginAttempt = Date.now()
      this.#keepAliveFailures = 0
      this.#log.debug('Alarm.com session established')
      this.#onSessionEstablished?.()
      return this.#session
    } catch (error) {
      this.#session = null
      this.#keepAliveFailures = 0

      // These two are permanent until the user changes something. Say so
      // plainly, because the alternative is a log full of identical retries.
      // Stamp the floor so we do not hammer Alarm.com with the same rejection.
      if (error instanceof TwoFactorRequiredError) {
        this.#lastLoginAttempt = Date.now()
        this.#log.error(
          'Alarm.com requires two-factor verification. Copy a fresh "twoFactorAuthenticationId" cookie from a signed-in browser into the plugin config.',
        )
      } else if (error instanceof AuthenticationError) {
        this.#lastLoginAttempt = Date.now()
        this.#log.error(
          'Alarm.com rejected the configured credentials. Fix them before restarting; repeated failed sign-ins can lock the account.',
        )
      }

      throw error
    }
  }

  /**
   * Refresh the session without a full login.
   *
   * @returns Whether a live session is still held afterwards.
   */
  async touch(): Promise<boolean> {
    const session = this.#session
    if (!session) {
      return false
    }

    try {
      const isAlive = await keepAlive(session)
      if (!isAlive) {
        this.#log.debug('keep-alive reported the session is no longer valid')
        // Only clear if this is still the session we probed. A concurrent
        // invalidate()+re-login can install a newer session while keep-alive
        // was in flight; wiping that would force another policed login.
        if (this.#session === session) {
          this.#session = null
          this.#keepAliveFailures = 0
        }
        return false
      }
      this.#keepAliveFailures = 0
      return true
    } catch (error) {
      // Transport errors are inconclusive once; repeated failures against the
      // same session mean the cookies are almost certainly dead.
      if (this.#session !== session) {
        return false
      }

      this.#keepAliveFailures++
      this.#log.debug(
        `keep-alive failed (${this.#keepAliveFailures}/${KEEPALIVE_FAILURE_LIMIT}): ${String(error)}`,
      )

      if (this.#keepAliveFailures >= KEEPALIVE_FAILURE_LIMIT) {
        this.#log.warn(
          'Alarm.com keep-alive failed repeatedly; discarding the session so the next request re-authenticates',
        )
        this.#session = null
        this.#keepAliveFailures = 0
      }
      return false
    }
  }

  /** Discard the current session so the next call re-authenticates. */
  invalidate(): void {
    this.#session = null
    this.#keepAliveFailures = 0
  }

  /** Whether a session is currently held. Does not trigger a login. */
  get hasSession(): boolean {
    return this.#session !== null
  }
}
