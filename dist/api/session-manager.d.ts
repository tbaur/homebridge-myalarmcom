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
import type { Logger } from '../utils/logger';
import { type Credentials, type Session } from './auth';
export interface SessionManagerOptions {
    credentials: Credentials;
    /** How long a session may go unverified before a fresh login, in minutes. */
    authIntervalMinutes: number;
    log: Logger;
    /** Called after a successful sign-in, for diagnostics. */
    onSessionEstablished?: () => void;
    /** Cancels in-flight authentication when the platform shuts down. */
    signal?: AbortSignal;
}
/** Establishes, reuses, and refreshes the Alarm.com session. */
export declare class SessionManager {
    #private;
    constructor(options: SessionManagerOptions);
    /**
     * Return a usable session, logging in only if necessary.
     *
     * Concurrent callers during a login all await the same attempt rather than
     * each starting their own, which would be both wasteful and the exact
     * pattern that trips abuse detection.
     */
    getSession(): Promise<Session>;
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
    touch(): Promise<boolean>;
    /** Discard the current session so the next call re-authenticates. */
    invalidate(): void;
    /** Whether a session is currently held. Does not trigger a login. */
    get hasSession(): boolean;
}
//# sourceMappingURL=session-manager.d.ts.map