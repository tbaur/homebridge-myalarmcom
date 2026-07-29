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
 */
/** Accumulates `Set-Cookie` values across an exchange with Alarm.com. */
export declare class CookieJar {
    #private;
    /** Merge every `Set-Cookie` on a response into the jar. */
    absorb(response: Response): void;
    /** Set a cookie directly, for values supplied by configuration. */
    set(name: string, value: string): void;
    get(name: string): string | undefined;
    has(name: string): boolean;
    /** Cookie names only. Safe to log; the values never are. */
    get names(): string[];
    get size(): number;
    /** Serialized value for a `Cookie` request header. */
    toHeader(): string;
}
//# sourceMappingURL=cookie-jar.d.ts.map