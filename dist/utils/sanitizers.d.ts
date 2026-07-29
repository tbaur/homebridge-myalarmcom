/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Redaction utilities that keep credentials out of logs.
 *
 * Alarm.com authentication is cookie-based, and the cookies are the whole
 * credential: anyone holding `twoFactorAuthenticationId` plus a session cookie
 * can act as the user without a password and without tripping 2FA. Debug logs
 * from a Homebridge instance routinely get pasted into public issue trackers,
 * so redaction here is a real control, not hygiene theatre.
 *
 * Two design rules follow from that, both learned from defects:
 *
 * 1. Every secret is declared once, in {@link SECRET_KEYS}, and both the JSON
 *    and `name=value` patterns are generated from it. Maintaining two parallel
 *    lists by hand is how `ASP.NET_SessionId` ended up redacted in a cookie but
 *    logged verbatim in a JSON body.
 * 2. Cookies are handled by exception, not by enumeration. A cookie the plugin
 *    has never heard of is redacted; only names known to be innocuous survive.
 *    Enumerating secrets means the next cookie Alarm.com adds leaks by default.
 */
/** Remove sensitive data from an arbitrary string. */
export declare function sanitizeString(value: string): string;
/** Convert an unknown thrown value into a sanitized, log-safe message. */
export declare function sanitizeError(err: unknown): string;
/**
 * Render a value passed alongside a log message so it cannot leak a secret.
 *
 * Objects are flattened to sanitized JSON rather than handed to the underlying
 * logger intact. Passing an object through untouched means its property values
 * never meet a redaction pattern, and a `cookieHeader` or `password` field
 * would print in full.
 */
export declare function sanitizeLogParameter(value: unknown): unknown;
/**
 * Render a secret as a short, non-reversible fingerprint for diagnostics.
 *
 * Enough to tell "the token changed" or "the token is empty" apart in a log.
 * Never a slice of the secret itself: disclosing even four characters of a
 * credential buys no diagnostic power that a fingerprint does not, and a log
 * is not a place to spend any of a secret's entropy.
 */
export declare function previewSecret(secret: string | undefined | null): string;
/**
 * Strip the query string from a URL for logging.
 *
 * Alarm.com puts identifiers and the event-stream token in query parameters,
 * so a bare path is the safe thing to log.
 */
export declare function sanitizeUrl(url: string): string;
//# sourceMappingURL=sanitizers.d.ts.map