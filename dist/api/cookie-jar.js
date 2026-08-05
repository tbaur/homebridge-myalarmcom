"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CookieJar = void 0;
/** Accumulates `Set-Cookie` values across an exchange with Alarm.com. */
class CookieJar {
    #cookies = new Map();
    /** Merge every `Set-Cookie` on a response into the jar. */
    absorb(headers) {
        for (const raw of headers.getSetCookie()) {
            const pair = raw.split(';')[0] ?? '';
            const separator = pair.indexOf('=');
            if (separator === -1) {
                continue;
            }
            const name = pair.slice(0, separator).trim();
            const value = pair.slice(separator + 1).trim();
            // Alarm.com clears a cookie by re-issuing it empty. Honour that as a
            // delete so a stale value cannot outlive the server's intent.
            if (value === '' || value === 'deleted') {
                this.#cookies.delete(name);
                continue;
            }
            this.#cookies.set(name, value);
        }
    }
    /** The value stored under a cookie name, or `undefined` if absent. */
    get(name) {
        return this.#cookies.get(name);
    }
    /** Cookie names only. Safe to log; the values never are. */
    get names() {
        return [...this.#cookies.keys()];
    }
    /** Serialized value for a `Cookie` request header. */
    toHeader() {
        return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }
}
exports.CookieJar = CookieJar;
//# sourceMappingURL=cookie-jar.js.map