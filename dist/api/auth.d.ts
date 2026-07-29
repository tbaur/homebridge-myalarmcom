/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Alarm.com authentication and session lifecycle.
 *
 * Alarm.com has no consumer API. A browser signs in through an ASP.NET WebForms
 * postback and then calls a JSON:API surface using the resulting session cookies
 * plus an anti-CSRF value echoed back in a custom header. This module reproduces
 * exactly that and nothing more.
 */
import type { Logger } from '../utils/logger';
/** Credentials needed to establish a session. */
export interface Credentials {
    username: string;
    password: string;
    /** The `twoFactorAuthenticationId` cookie value, or empty if 2FA is off. */
    twoFactorAuthenticationId: string;
}
/** An authenticated Alarm.com web session. */
export interface Session {
    /** Serialized `Cookie` header to replay on every API request. */
    cookieHeader: string;
    /** Anti-CSRF value for the `ajaxrequestuniquekey` header. */
    ajaxKey: string;
    /** When this session was established. */
    createdAt: Date;
}
/** Result of scraping the login page. */
interface HiddenFields {
    found: Record<string, string>;
    missing: string[];
}
/**
 * Pull the hidden WebForms inputs out of the login page HTML.
 *
 * Reports what was missing rather than throwing on the first absent field,
 * because "Alarm.com changed its login form" is a far more actionable diagnosis
 * than a generic failure further downstream.
 */
export declare function scrapeHiddenFields(html: string): HiddenFields;
/**
 * Build the login postback body.
 *
 * The three `__EVENT*` values are sent as the literal string `"null"`. That is
 * not a bug: it is what Alarm.com's endpoint demonstrably accepts today.
 * Against an undocumented service, matching known-working bytes beats sending
 * what ought to be correct.
 */
export declare function buildLoginBody(username: string, password: string, hiddenFields: Record<string, string>): URLSearchParams;
/**
 * Establish a signed-in session.
 *
 * Only the cookies returned by the login POST are kept. Cookies picked up from
 * the login page beforehand are deliberately discarded: replaying the full set
 * was tested against a live account and Alarm.com rejected it with a two-factor
 * challenge, while the login-response set alone was accepted. This is the one
 * non-obvious detail that makes the whole flow work.
 *
 * @throws {LoginFormError} The login page could not be parsed.
 * @throws {TwoFactorRequiredError} Alarm.com demanded two-factor verification.
 * @throws {AuthenticationError} The credentials were rejected.
 */
export declare function authenticate(credentials: Credentials, log: Logger): Promise<Session>;
/**
 * Touch the session so Alarm.com keeps it alive.
 *
 * Materially safer than re-authenticating: signing in is the request Alarm.com
 * polices for abuse, so refreshing an existing session avoids the operation
 * most likely to lock the account.
 *
 * @returns Whether the session is still valid.
 */
export declare function keepAlive(session: Session): Promise<boolean>;
export {};
//# sourceMappingURL=auth.d.ts.map