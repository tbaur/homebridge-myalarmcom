/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Minimal cookie store for the Alarm.com web session.
 *
 * Deliberately not a general-purpose cookie implementation: there is no domain,
 * path, or expiry handling, because every request goes to one host and the
 * session lives entirely in memory for minutes at a time. A full cookie library
 * would be more code and more attack surface for no behavioural gain.
 *
 * That single-host assumption is enforced rather than assumed: `httpRequest`
 * refuses to send a `Cookie` header to any origin but Alarm.com, so this jar
 * cannot leak across hosts even if a future change follows a redirect.
 */
/** Accumulates `Set-Cookie` values across an exchange with Alarm.com. */
export declare class CookieJar {
    #private;
    /** Merge every `Set-Cookie` on a response into the jar. */
    absorb(headers: Headers): void;
    /** The value stored under a cookie name, or `undefined` if absent. */
    get(name: string): string | undefined;
    /** Cookie names only. Safe to log; the values never are. */
    get names(): string[];
    /** Serialized value for a `Cookie` request header. */
    toHeader(): string;
}
//# sourceMappingURL=cookie-jar.d.ts.map