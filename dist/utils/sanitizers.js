"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeString = sanitizeString;
exports.sanitizeError = sanitizeError;
exports.sanitizeLogParameter = sanitizeLogParameter;
exports.lengthBand = lengthBand;
exports.previewSecret = previewSecret;
exports.sanitizeUrl = sanitizeUrl;
const node_crypto_1 = require("node:crypto");
/**
 * Per-process salt for {@link previewSecret} fingerprints.
 *
 * Random rather than a constant. A fingerprint only ever needs to answer "is
 * this the same value as the last line said?", which holds within one process,
 * and a hard-coded salt in a public repository turns the digest into an offline
 * oracle that can confirm a guessed secret. Regenerating per process costs
 * nothing and removes that property entirely.
 */
const SECRET_PREVIEW_SALT = (0, node_crypto_1.randomBytes)(16);
/**
 * Upper bound on the text a single sanitize pass will scan.
 *
 * Alarm.com serves whole HTML pages where JSON is expected, so an error message
 * can carry megabytes. Every pattern here is linear, but running twenty of them
 * over megabytes still blocks the event loop inside the logger.
 */
const MAX_SANITIZE_LENGTH = 8_192;
/**
 * Every value that must never reach a log, declared once.
 *
 * Adding a secret here covers it in all supported shapes automatically.
 */
const SECRET_KEYS = [
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
];
/**
 * Cookie names and cookie attributes that carry nothing sensitive.
 *
 * Everything else in a cookie header is redacted, so this list failing to
 * mention a new Alarm.com cookie costs a slightly noisier log rather than a
 * disclosed credential.
 */
const NON_SENSITIVE_COOKIE_NAMES = new Set([
    // Cookie attributes, which are not name/value pairs at all.
    'path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly', 'version',
    // Alarm.com preference and telemetry cookies observed on a live account.
    'isfromnewsite', 'cookietest',
    'adc_e_alarm_locale', 'adc_e_cookie_banner', 'adc_e_donottrack',
    'adc_e_gpc_enabled', 'adc_e_loggedinassubscriber', 'adc_e_origin_locale',
]);
function escapeForPattern(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Allow a name to match however it is punctuated.
 *
 * `twoFactorAuthenticationId` and `two_factor_authentication_id` are the same
 * secret. Word boundaries are found from the camelCase humps and from any
 * separators already present, then each boundary is allowed to be `_`, `-`, or
 * nothing. Enumerating both spellings by hand is the mistake this file's header
 * already records once.
 */
function aliasPattern(alias) {
    // Marked before escaping, because the escaped form and the substituted
    // character class both contain characters this would otherwise re-match.
    const BOUNDARY = '\u0000';
    return alias
        .replace(/[_-]/g, BOUNDARY)
        .replace(/(?<=[a-z0-9])(?=[A-Z])/g, BOUNDARY)
        .split(BOUNDARY)
        .map(escapeForPattern)
        .join('[_-]?');
}
/**
 * The body of a JSON string, allowing escaped characters.
 *
 * `[^"]*` is the obvious spelling and it is wrong: it stops at the first quote,
 * so a password containing `\"` had everything after that quote printed in
 * cleartext while the line still ended in a reassuring `***`.
 */
const JSON_STRING_BODY = '(?:[^"\\\\]|\\\\.)*';
/**
 * Build the redaction rules for one secret.
 *
 * The JSON form must come first. In `"key":"value"` a quote sits between the
 * key and its colon, so no `name=value` pattern can match it, and relying on
 * one is exactly the gap that leaked session ids out of API error bodies.
 */
function rulesForSecret({ canonical, aliases }) {
    const group = aliases.map(aliasPattern).join('|');
    return [
        {
            pattern: new RegExp(`"(?:${group})"\\s*:\\s*"${JSON_STRING_BODY}"`, 'gi'),
            replacement: `"${canonical}":"***"`,
        },
        { pattern: new RegExp(`\\b(?:${group})\\s*[=:]\\s*"?[^;&\\s"']*`, 'gi'), replacement: `${canonical}=***` },
    ];
}
/**
 * JSON keys whose *name* suggests the value is a credential.
 *
 * Tested against a captured key rather than woven into the surrounding pattern.
 * Inlining it produced `"[\w.-]*(?:secret|token|…)[\w.-]*"`, whose leading
 * character class overlaps the alternation that follows it — cleanly quadratic,
 * and measurably so: 27ms at the truncation cap.
 */
const CREDENTIAL_KEY_SHAPE = /secret|token|passw(?:or)?d|api[_-]?key|sessionid|credential|authoriz/i;
/** Any JSON `"key": "value"` pair. Linear: the key class cannot contain a quote. */
const JSON_KEY_VALUE = new RegExp(`"([\\w.$-]+)"\\s*:\\s*"${JSON_STRING_BODY}"`, 'g');
/**
 * Patterns for sensitive data that must never reach a log.
 *
 * Every pattern is linear: no nested quantifiers, and no quantified class that
 * can overlap the literal or alternation following it. That second condition is
 * the one that is easy to miss — a key pattern built as
 * `[\w.-]*(?:token|secret)[\w.-]*` looks harmless and backtracks quadratically.
 * Where a name has to be *matched* rather than described, capture it and test
 * it separately (see {@link CREDENTIAL_KEY_SHAPE}). The suite times a
 * pathological input to keep this honest.
 */
const SENSITIVE_PATTERNS = [
    ...SECRET_KEYS.flatMap(rulesForSecret),
    // Whole Cookie/Set-Cookie headers, in JSON and header form. The header form
    // cannot match the JSON one for the same quote-before-colon reason above.
    {
        pattern: new RegExp(`"(?:set-)?cookie"\\s*:\\s*"${JSON_STRING_BODY}"`, 'gi'),
        replacement: '"cookie":"***"',
    },
    { pattern: /\b(set-)?cookie\s*:\s*[^\n\r]*/gi, replacement: 'cookie: ***' },
    // Event-stream token, which rides in the query string of the socket URL.
    // It is not one opaque parameter: it arrives already percent-escaped and
    // containing structural `&`, so redacting only as far as the first separator
    // leaves most of the token, and its signature, in the log.
    { pattern: /([?&]auth=)[^\s"']*/gi, replacement: '$1***' },
    // Any Authorization header, with or without a scheme. Basic carries the
    // password itself, and `Basic <base64>` has no `=` for the length backstop
    // below to catch. A scheme is kept when present, because knowing whether a
    // request sent Basic or Bearer is diagnostically useful and discloses
    // nothing; a schemeless value is redacted whole.
    {
        pattern: /\b(authorization\s*:\s*)([^\s,;"']+)(\s+[^\s,;"']+)?/gi,
        redact: (_match, prefix, scheme, credential) => credential === undefined ? `${prefix}***` : `${prefix}${scheme} ***`,
    },
    // Runs to the end of the credential, not to the first `&`. A bearer token is
    // not a query parameter, so `&` is part of the value rather than a separator.
    { pattern: /\bbearer\s+[^\s,"']+/gi, replacement: 'Bearer ***' },
    // Credential-shaped JSON keys the plugin has never seen. SECRET_KEYS covers
    // the names Alarm.com uses today; this covers the ones a future payload,
    // dependency, or copy-pasted capture might introduce. Redacting by shape
    // costs a slightly noisier log and fails closed, which is the trade this
    // file makes everywhere else. Only the value is replaced — a field *name*
    // is not a secret, and keeping it is what makes the log still readable.
    {
        pattern: JSON_KEY_VALUE,
        redact: (match, key) => (CREDENTIAL_KEY_SHAPE.test(key) ? `"${key}":"***"` : match),
    },
];
/** Two or more `name=value` pairs joined by `;`, i.e. a serialized cookie header. */
const COOKIE_HEADER_SHAPE = /(?:^|\s)[\w.~$-]+=[^;\s]*;\s*[\w.~$-]+=/;
const COOKIE_PAIR = /([\w.~$-]+)=([^;\s]+)/g;
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
const LONG_VALUE_PAIR = /\b([\w.~$-]+)=([\w%./+~-]{16,})/g;
/**
 * Redact values the plugin cannot vouch for, by exception rather than by name.
 *
 * `Session.cookieHeader` is a bare `name=value; name=value` string with no
 * `Cookie:` prefix, so the header rule above never sees it. Any credential
 * Alarm.com starts issuing under a new name would otherwise be logged in full.
 */
function redactUnknownCookies(value) {
    const isCookieHeader = COOKIE_HEADER_SHAPE.test(value);
    const pattern = isCookieHeader ? COOKIE_PAIR : LONG_VALUE_PAIR;
    return value.replace(pattern, (match, name) => NON_SENSITIVE_COOKIE_NAMES.has(name.toLowerCase()) ? match : `${name}=***`);
}
/** Remove sensitive data from an arbitrary string. */
function sanitizeString(value) {
    let result = value.length > MAX_SANITIZE_LENGTH
        ? `${value.slice(0, MAX_SANITIZE_LENGTH)}… (${value.length} chars truncated)`
        : value;
    for (const rule of SENSITIVE_PATTERNS) {
        result = 'redact' in rule
            ? result.replace(rule.pattern, rule.redact)
            : result.replace(rule.pattern, rule.replacement);
    }
    return redactUnknownCookies(result);
}
/** How many wrapped causes to unwrap before giving up on a cycle. */
const MAX_CAUSE_DEPTH = 5;
/**
 * Convert an unknown thrown value into a sanitized, log-safe message.
 *
 * The cause chain is walked, because the wrapper is rarely the useful half: a
 * `NetworkError` saying "request failed" wraps the `ECONNREFUSED` that actually
 * tells an operator what to fix.
 */
function sanitizeError(err) {
    if (typeof err === 'string') {
        return sanitizeString(err);
    }
    if (!(err instanceof Error)) {
        return sanitizeString(String(err));
    }
    const parts = [err.message];
    let cause = err.cause;
    for (let depth = 0; depth < MAX_CAUSE_DEPTH && cause instanceof Error; depth++) {
        if (cause.message && !parts.includes(cause.message)) {
            parts.push(cause.message);
        }
        cause = cause.cause;
    }
    return sanitizeString(parts.join(': '));
}
/**
 * Render a value passed alongside a log message so it cannot leak a secret.
 *
 * Objects are flattened to sanitized JSON rather than handed to the underlying
 * logger intact. Passing an object through untouched means its property values
 * never meet a redaction pattern, and a `cookieHeader` or `password` field
 * would print in full.
 */
function sanitizeLogParameter(value) {
    if (typeof value === 'string') {
        return sanitizeString(value);
    }
    if (value instanceof Error) {
        return sanitizeError(value);
    }
    if (value === null || typeof value !== 'object') {
        return value;
    }
    try {
        return sanitizeString(JSON.stringify(value) ?? UNSERIALIZABLE);
    }
    catch {
        // Circular or otherwise unserializable. The constructor name says more than
        // `[object Object]` and cannot itself carry a secret.
        return `${UNSERIALIZABLE} ${value.constructor?.name ?? 'object'}`;
    }
}
/** Stand-in for a value that cannot be rendered without risking a leak. */
const UNSERIALIZABLE = '[unserializable]';
/**
 * Coarse size band for a secret.
 *
 * A band answers the only question a log needs ("does this look like a real
 * token or a truncated paste?") without publishing the exact length, which is
 * one more fact an attacker holding the log would not otherwise have.
 */
function lengthBand(length) {
    if (length < 20) {
        return 'under 20';
    }
    if (length < 50) {
        return '20-49';
    }
    if (length < 100) {
        return '50-99';
    }
    return '100+';
}
/**
 * Fingerprints already computed this process.
 *
 * scrypt at Node's defaults allocates ~16 MB and blocks the event loop for tens
 * of milliseconds. The same handful of secrets are previewed on every login, so
 * without this the periodic re-authentication stalls the whole child bridge on
 * a timer. The secrets are already resident in the session manager, so caching
 * them here exposes nothing new — but it is capped anyway, because an unbounded
 * structure keyed on plaintext credentials is the wrong shape to leave lying
 * around whatever the current call sites happen to do.
 */
const fingerprintCache = new Map();
/** Enough for the two or three secrets one process ever previews. */
const MAX_FINGERPRINT_CACHE_ENTRIES = 8;
/**
 * Render a secret as a short, non-reversible fingerprint for diagnostics.
 *
 * Enough to tell "the token changed" or "the token is empty" apart in a log.
 * Never a slice of the secret itself: disclosing even four characters of a
 * credential buys no diagnostic power that a fingerprint does not, and a log
 * is not a place to spend any of a secret's entropy.
 *
 * CodeQL's password-hash query only accepts memory-hard KDFs for
 * password-tainted values, which is why this is scrypt rather than an HMAC.
 */
function previewSecret(secret) {
    if (!secret) {
        return '(none)';
    }
    let fingerprint = fingerprintCache.get(secret);
    if (fingerprint === undefined) {
        fingerprint = (0, node_crypto_1.scryptSync)(secret, SECRET_PREVIEW_SALT, 4).toString('hex');
        if (fingerprintCache.size >= MAX_FINGERPRINT_CACHE_ENTRIES) {
            fingerprintCache.clear();
        }
        fingerprintCache.set(secret, fingerprint);
    }
    return `(${lengthBand(secret.length)} chars, scrypt:${fingerprint})`;
}
/**
 * Strip the query string from a URL for logging.
 *
 * Alarm.com puts identifiers and the event-stream token in query parameters,
 * so a bare path is the safe thing to log.
 */
function sanitizeUrl(url) {
    try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
    }
    catch {
        return sanitizeString(url);
    }
}
//# sourceMappingURL=sanitizers.js.map