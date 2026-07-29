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

import { createHash } from 'node:crypto'

/** A secret, the names it appears under, and the name to show once redacted. */
interface SecretKey {
  /** Every spelling this secret is known to appear under. */
  readonly aliases: readonly string[]
  /** The name written into redacted output. */
  readonly canonical: string
}

/**
 * Every value that must never reach a log, declared once.
 *
 * Adding a secret here covers it in all supported shapes automatically.
 */
const SECRET_KEYS: readonly SecretKey[] = [
  // Two-factor bypass token. The single most sensitive value the plugin holds.
  { canonical: 'twoFactorAuthenticationId', aliases: ['twoFactorAuthenticationId'] },

  // Credentials posted to the WebForms login endpoint.
  { canonical: 'password', aliases: ['txtPassword', 'password', 'passwd', 'pwd'] },

  // Session and anti-CSRF cookies. Each is equivalent to a live login.
  { canonical: 'ASP.NET_SessionId', aliases: ['ASP.NET_SessionId'] },
  { canonical: 'afg', aliases: ['afg'] },
  { canonical: 'auth_CustomerDotNet', aliases: ['auth_CustomerDotNet'] },
  { canonical: 'ajaxrequestuniquekey', aliases: ['ajaxrequestuniquekey'] },

  // ASP.NET view state. Opaque, enormous, and can encode session context.
  { canonical: '__VIEWSTATE', aliases: ['__VIEWSTATE'] },
  { canonical: '__EVENTVALIDATION', aliases: ['__EVENTVALIDATION'] },
  { canonical: '__PREVIOUSPAGE', aliases: ['__PREVIOUSPAGE'] },
]

/**
 * Cookie names and cookie attributes that carry nothing sensitive.
 *
 * Everything else in a cookie header is redacted, so this list failing to
 * mention a new Alarm.com cookie costs a slightly noisier log rather than a
 * disclosed credential.
 */
const NON_SENSITIVE_COOKIE_NAMES: ReadonlySet<string> = new Set([
  // Cookie attributes, which are not name/value pairs at all.
  'path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly', 'version',
  // Alarm.com preference and telemetry cookies observed on a live account.
  'isfromnewsite', 'cookietest',
  'adc_e_alarm_locale', 'adc_e_cookie_banner', 'adc_e_donottrack',
  'adc_e_gpc_enabled', 'adc_e_loggedinassubscriber', 'adc_e_origin_locale',
])

const escapeForPattern = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Build the redaction rules for one secret.
 *
 * The JSON form must come first. In `"key":"value"` a quote sits between the
 * key and its colon, so no `name=value` pattern can match it, and relying on
 * one is exactly the gap that leaked session ids out of API error bodies.
 */
function rulesForSecret({ canonical, aliases }: SecretKey): Array<{ pattern: RegExp, replacement: string }> {
  const group = aliases.map(escapeForPattern).join('|')

  return [
    { pattern: new RegExp(`"(?:${group})"\\s*:\\s*"[^"]*"`, 'gi'), replacement: `"${canonical}":"***"` },
    { pattern: new RegExp(`\\b(?:${group})\\s*[=:]\\s*"?[^;&\\s"']*`, 'gi'), replacement: `${canonical}=***` },
  ]
}

/**
 * Patterns for sensitive data that must never reach a log.
 *
 * Every pattern is linear with no nested quantifiers, so none is vulnerable to
 * catastrophic backtracking on a large or hostile input.
 */
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp, replacement: string }> = [
  ...SECRET_KEYS.flatMap(rulesForSecret),

  // Whole Cookie/Set-Cookie headers, in JSON and header form. The header form
  // cannot match the JSON one for the same quote-before-colon reason above.
  { pattern: /"(?:set-)?cookie"\s*:\s*"[^"]*"/gi, replacement: '"cookie":"***"' },
  { pattern: /\b(set-)?cookie\s*:\s*[^\n\r]*/gi, replacement: 'cookie: ***' },

  // Event-stream token, which rides in the query string of the socket URL.
  // It is not one opaque parameter: it arrives already percent-escaped and
  // containing structural `&`, so redacting only as far as the first separator
  // leaves most of the token, and its signature, in the log.
  { pattern: /([?&]auth=)[^\s"']*/gi, replacement: '$1***' },

  // Runs to the end of the credential, not to the first `&`. A bearer token is
  // not a query parameter, so `&` is part of the value rather than a separator.
  { pattern: /\bbearer\s+[^\s,"']+/gi, replacement: 'Bearer ***' },
]

/** Two or more `name=value` pairs joined by `;`, i.e. a serialized cookie header. */
const COOKIE_HEADER_SHAPE = /(?:^|\s)[\w.~$-]+=[^;\s]*;\s*[\w.~$-]+=/
const COOKIE_PAIR = /([\w.~$-]+)=([^;\s]+)/g

/**
 * A `name=value` pair whose value is long enough to be a credential.
 *
 * The length floor is what makes this safe to apply to arbitrary text. A lone
 * cookie carries no `;` to identify it as one, so without a floor the only way
 * to catch it would be to redact every `name=value` in every log line, which
 * would take `state=2` and `attempt=3` with it and make debugging worse. No
 * credential Alarm.com issues is under sixteen characters; no state value the
 * plugin logs is over it.
 */
const LONG_VALUE_PAIR = /\b([\w.~$-]+)=([\w%./+~-]{16,})/g

/**
 * Redact values the plugin cannot vouch for, by exception rather than by name.
 *
 * `Session.cookieHeader` is a bare `name=value; name=value` string with no
 * `Cookie:` prefix, so the header rule above never sees it. Any credential
 * Alarm.com starts issuing under a new name would otherwise be logged in full.
 */
function redactUnknownCookies(value: string): string {
  const isCookieHeader = COOKIE_HEADER_SHAPE.test(value)
  const pattern = isCookieHeader ? COOKIE_PAIR : LONG_VALUE_PAIR

  return value.replace(pattern, (match, name: string) =>
    NON_SENSITIVE_COOKIE_NAMES.has(name.toLowerCase()) ? match : `${name}=***`)
}

/** Remove sensitive data from an arbitrary string. */
export function sanitizeString(value: string): string {
  let result = value
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return redactUnknownCookies(result)
}

/** Convert an unknown thrown value into a sanitized, log-safe message. */
export function sanitizeError(err: unknown): string {
  if (err instanceof Error) {
    return sanitizeString(err.message)
  }
  if (typeof err === 'string') {
    return sanitizeString(err)
  }
  return sanitizeString(String(err))
}

/**
 * Render a value passed alongside a log message so it cannot leak a secret.
 *
 * Objects are flattened to sanitized JSON rather than handed to the underlying
 * logger intact. Passing an object through untouched means its property values
 * never meet a redaction pattern, and a `cookieHeader` or `password` field
 * would print in full.
 */
export function sanitizeLogParameter(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeString(value)
  }
  if (value instanceof Error) {
    return sanitizeError(value)
  }
  if (value === null || typeof value !== 'object') {
    return value
  }

  try {
    return sanitizeString(JSON.stringify(value) ?? String(value))
  } catch {
    // Circular or otherwise unserializable. Fall back to the string form,
    // which is still redacted rather than passed through.
    return sanitizeString(String(value))
  }
}

/**
 * Render a secret as a short, non-reversible fingerprint for diagnostics.
 *
 * Enough to tell "the token changed" or "the token is empty" apart in a log.
 * The fingerprint is a hash rather than a slice of the value itself: disclosing
 * even four characters of a credential buys no diagnostic power that a hash
 * does not, and a log is not a place to spend any of a secret's entropy.
 */
export function previewSecret(secret: string | undefined | null): string {
  if (!secret) {
    return '(none)'
  }
  const fingerprint = createHash('sha256').update(secret).digest('hex').slice(0, 8)
  return `(${secret.length} chars, sha256:${fingerprint})`
}

/**
 * Strip the query string from a URL for logging.
 *
 * Alarm.com puts identifiers and the event-stream token in query parameters,
 * so a bare path is the safe thing to log.
 */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return sanitizeString(url)
  }
}
