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
export class CookieJar {
  readonly #cookies = new Map<string, string>()

  /** Merge every `Set-Cookie` on a response into the jar. */
  absorb(headers: Headers): void {
    for (const raw of headers.getSetCookie()) {
      const pair = raw.split(';')[0] ?? ''
      const separator = pair.indexOf('=')
      if (separator === -1) {
        continue
      }

      const name = pair.slice(0, separator).trim()
      const value = pair.slice(separator + 1).trim()

      // Alarm.com clears a cookie by re-issuing it empty. Honour that as a
      // delete so a stale value cannot outlive the server's intent.
      if (value === '' || value === 'deleted') {
        this.#cookies.delete(name)
        continue
      }

      this.#cookies.set(name, value)
    }
  }

  /** The value stored under a cookie name, or `undefined` if absent. */
  get(name: string): string | undefined {
    return this.#cookies.get(name)
  }

  /** Cookie names only. Safe to log; the values never are. */
  get names(): string[] {
    return [...this.#cookies.keys()]
  }

  /** Serialized value for a `Cookie` request header. */
  toHeader(): string {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }
}
