/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Debug logs from Homebridge routinely end up pasted into public issue
 * trackers, and an Alarm.com session cookie is a complete credential. These
 * tests treat any surviving secret substring as a failure rather than checking
 * that a particular regex fired.
 */

import {
  previewSecret,
  sanitizeError,
  sanitizeString,
  sanitizeUrl,
} from '../../../src/utils/sanitizers'

const TRUST_TOKEN = 'QUJDREVGRw-trust-token-value'
const PASSWORD = 'correct-horse-battery'
const SESSION_ID = 'lqzo0hgibbfnbtx5wzcbvsxr'
const CSRF = 'a3f9c1e2b7d4'
const VIEWSTATE = 'wEPDwUKMTY1NDU2NzIwOWRk'
const SESSION_COOKIE = 'JgYFAwQCAQ-auth-customer-value'

/**
 * The real event-stream token is not one opaque parameter. It arrives already
 * percent-escaped and carries structural `&`, so it expands into several query
 * parameters. A single-part fixture here is what let a redaction bug that left
 * the signature in the log pass the suite.
 */
const STREAM_TOKEN = 'id%3D42&sig%3DeyJhbGciOiJIUzI1NiJ9stream&exp%3D1700000000'

describe('sanitizeString', () => {
  describe('the two-factor trust token', () => {
    it('redacts it in a JSON body', () => {
      expect(sanitizeString(`{"twoFactorAuthenticationId":"${TRUST_TOKEN}"}`))
        .toBe('{"twoFactorAuthenticationId":"***"}')
    })

    it('redacts it in a cookie', () => {
      expect(sanitizeString(`twoFactorAuthenticationId=${TRUST_TOKEN}; path=/`))
        .toBe('twoFactorAuthenticationId=***; path=/')
    })

    it('redacts it regardless of case', () => {
      expect(sanitizeString(`twofactorauthenticationid=${TRUST_TOKEN}`)).not.toContain(TRUST_TOKEN)
    })
  })

  describe('passwords', () => {
    it('redacts a JSON password field', () => {
      expect(sanitizeString(`{"password":"${PASSWORD}"}`)).toBe('{"password":"***"}')
    })

    it('redacts the WebForms password field name Alarm.com uses', () => {
      expect(sanitizeString(`{"txtPassword":"${PASSWORD}"}`)).toBe('{"password":"***"}')
    })

    it('redacts a form-encoded password', () => {
      expect(sanitizeString(`txtPassword=${PASSWORD}&IsFromNewSite=1`))
        .toBe('password=***&IsFromNewSite=1')
    })

    it('redacts the common short spellings', () => {
      expect(sanitizeString(`pwd=${PASSWORD}`)).toBe('password=***')
      expect(sanitizeString(`passwd=${PASSWORD}`)).toBe('password=***')
    })
  })

  describe('session and anti-CSRF cookies', () => {
    it('redacts the ASP.NET session cookie', () => {
      expect(sanitizeString(`ASP.NET_SessionId=${SESSION_ID}; path=/`))
        .toBe('ASP.NET_SessionId=***; path=/')
    })

    it('redacts the afg anti-CSRF cookie', () => {
      expect(sanitizeString(`afg=${CSRF}; path=/`)).toBe('afg=***; path=/')
    })

    it('redacts the anti-CSRF request header', () => {
      expect(sanitizeString(`ajaxrequestuniquekey: ${CSRF}`)).toBe('ajaxrequestuniquekey=***')
    })

    it('redacts the auth_CustomerDotNet session cookie', () => {
      expect(sanitizeString(`auth_CustomerDotNet=${SESSION_COOKIE}; path=/`))
        .toBe('auth_CustomerDotNet=***; path=/')
    })

    it('redacts an entire Cookie header, whatever it happens to carry', () => {
      const header = `Cookie: ASP.NET_SessionId=${SESSION_ID}; afg=${CSRF}; somethingNew=${TRUST_TOKEN}`

      expect(sanitizeString(header)).toBe('cookie: ***')
    })

    /**
     * `Session.cookieHeader` is a bare `name=value; name=value` string with no
     * `Cookie:` prefix, so the header rule never sees it. Cookies are therefore
     * redacted by exception: a name the plugin does not recognise is assumed to
     * be a credential, so the next one Alarm.com invents is covered by default.
     */
    it('redacts a cookie it has never heard of in a bare cookie header', () => {
      const header = `ASP.NET_SessionId=${SESSION_ID}; brandNewCookie=${TRUST_TOKEN}`

      const sanitized = sanitizeString(header)

      expect(sanitized).not.toContain(TRUST_TOKEN)
      expect(sanitized).toBe('ASP.NET_SessionId=***; brandNewCookie=***')
    })

    /**
     * A lone cookie carries no `;` to identify it as one, so the multi-pair
     * shape above never sees it. The value length is what distinguishes a
     * credential from `state=2`.
     */
    it('redacts a single unrecognised cookie with no other pair beside it', () => {
      expect(sanitizeString(`brandNewCookie=${TRUST_TOKEN}`)).toBe('brandNewCookie=***')
    })

    it.each([
      'state=2',
      'attempt=3',
      'deviceType=1',
      'Polling Alarm.com every 60s',
      'Discovered 1 partition(s) and 19 sensor(s)',
      'Rediscovering devices to detect panel add/remove changes: 1 partition(s) and 19 sensor(s)',
    ])('leaves ordinary diagnostic text alone: %s', (message) => {
      expect(sanitizeString(message)).toBe(message)
    })

    it('keeps the benign preference cookies readable', () => {
      const header = `adc_e_alarm_locale=en-US; afg=${CSRF}; path=/`

      expect(sanitizeString(header)).toBe('adc_e_alarm_locale=en-US; afg=***; path=/')
    })

    it('redacts a cookie header carried inside a JSON body', () => {
      expect(sanitizeString('{"cookie":"opaqueUnrecognisedValue"}'))
        .toBe('{"cookie":"***"}')
    })

    it('redacts session values written with a colon rather than an equals sign', () => {
      expect(sanitizeString(`ASP.NET_SessionId: ${SESSION_ID}`)).not.toContain(SESSION_ID)
      expect(sanitizeString(`afg: ${CSRF}`)).not.toContain(CSRF)
    })

    it('redacts an entire Set-Cookie header', () => {
      expect(sanitizeString(`set-cookie: afg=${CSRF}; HttpOnly`)).toBe('cookie: ***')
    })

    it('leaves the rest of a multi-header block intact', () => {
      const headers = [
        'Accept: application/vnd.api+json',
        `Cookie: afg=${CSRF}`,
        'Referer: https://www.alarm.com/web/system/home',
      ].join('\n')

      const sanitized = sanitizeString(headers)

      expect(sanitized).toContain('Accept: application/vnd.api+json')
      expect(sanitized).toContain('Referer: https://www.alarm.com/web/system/home')
      expect(sanitized).not.toContain(CSRF)
    })
  })

  describe('ASP.NET view state', () => {
    it('redacts __VIEWSTATE from a form body', () => {
      expect(sanitizeString(`__VIEWSTATE=${VIEWSTATE}&IsFromNewSite=1`))
        .toBe('__VIEWSTATE=***&IsFromNewSite=1')
    })

    it('redacts the other opaque WebForms fields', () => {
      expect(sanitizeString(`__EVENTVALIDATION=${VIEWSTATE}`)).toBe('__EVENTVALIDATION=***')
      expect(sanitizeString(`__PREVIOUSPAGE=${VIEWSTATE}`)).toBe('__PREVIOUSPAGE=***')
    })
  })

  describe('the event stream token', () => {
    it('redacts the auth parameter of the websocket URL', () => {
      expect(sanitizeString(`wss://webskt.alarm.com:8443?auth=${STREAM_TOKEN}`))
        .toBe('wss://webskt.alarm.com:8443?auth=***')
    })

    it('redacts it when it is not the first query parameter', () => {
      expect(sanitizeString(`wss://webskt.alarm.com:8443/?v=2&auth=${STREAM_TOKEN}`))
        .toBe('wss://webskt.alarm.com:8443/?v=2&auth=***')
    })

    /**
     * Regression. Redaction stopped at the first `&`, which is a separator
     * inside the token itself, so the signature survived in a log line that
     * displayed `auth=***` and looked safe.
     */
    it('redacts the whole token, including the parts after its internal separators', () => {
      const sanitized = sanitizeString(`wss://webskt.alarm.com:8443?auth=${STREAM_TOKEN}`)

      expect(sanitized).not.toContain('sig%3D')
      expect(sanitized).not.toContain('eyJhbGciOiJIUzI1NiJ9stream')
    })
  })

  describe('Authorization headers', () => {
    it('redacts a bearer token', () => {
      expect(sanitizeString(`Authorization: Bearer ${STREAM_TOKEN}`))
        .toBe('Authorization: Bearer ***')
    })

    /** Basic carries the password itself, and has no `=` for the length backstop. */
    it('redacts Basic credentials while keeping the scheme visible', () => {
      expect(sanitizeString('Authorization: Basic dXNlcjpjb3JyZWN0LWhvcnNl'))
        .toBe('Authorization: Basic ***')
    })

    it('redacts a scheme it has never heard of', () => {
      expect(sanitizeString('authorization: Acme-V2 aVerySecretValue'))
        .toBe('authorization: Acme-V2 ***')
    })
  })

  /**
   * SECRET_KEYS covers the names Alarm.com uses today. These are the shapes a
   * future payload or a copy-pasted capture could introduce, which a
   * name-by-name blocklist would let through by default.
   */
  describe('credential-shaped keys the plugin has never seen', () => {
    it.each([
      ['{"access_token":"aVerySecretValue"}', '{"access_token":"***"}'],
      ['{"apiKey":"aVerySecretValue"}', '{"apiKey":"***"}'],
      ['{"refreshToken":"aVerySecretValue"}', '{"refreshToken":"***"}'],
      ['{"sessionId":"aVerySecretValue"}', '{"sessionId":"***"}'],
      ['{"clientSecret":"aVerySecretValue"}', '{"clientSecret":"***"}'],
      ['{"authorization":"Basic abc"}', '{"authorization":"***"}'],
    ])('redacts the value of %s', (input, expected) => {
      expect(sanitizeString(input)).toBe(expected)
    })

    it('normalises separators, so snake_case spellings match too', () => {
      expect(sanitizeString(`{"two_factor_authentication_id":"${TRUST_TOKEN}"}`))
        .not.toContain(TRUST_TOKEN)
    })

    it('leaves an already-redacted value alone rather than losing the field name', () => {
      expect(sanitizeString('{"password":"***"}')).toBe('{"password":"***"}')
    })
  })

  /**
   * Alarm.com serves whole HTML pages where JSON is expected, so an error
   * message can carry megabytes. Every pattern is linear, but running twenty of
   * them over that much text still blocks the event loop inside the logger.
   */
  it('truncates an enormous input rather than scanning all of it', () => {
    const huge = 'a'.repeat(200_000)

    const sanitized = sanitizeString(huge)

    expect(sanitized.length).toBeLessThan(10_000)
    expect(sanitized).toContain('200000 chars truncated')
  })

  /**
   * `[^"]*` is the obvious way to spell a JSON string body and it is wrong: it
   * stops at the first quote. A password containing `\"` had everything after
   * that quote printed in cleartext while the line still ended in a reassuring
   * `***`, which is worse than no redaction because it looks handled.
   */
  it('redacts a whole JSON secret that itself contains an escaped quote', () => {
    const awkward = String.raw`abc\"def-tail-that-must-not-appear`

    const sanitized = sanitizeString(`{"password":"${awkward}"}`)

    expect(sanitized).toBe('{"password":"***"}')
    expect(sanitized).not.toContain('tail-that-must-not-appear')
  })

  it('redacts an Authorization header that carries no scheme', () => {
    const sanitized = sanitizeString('authorization: aVerySecretTokenValue123456')

    expect(sanitized).toBe('authorization: ***')
  })

  it('keeps the scheme but not the credential when there is one', () => {
    expect(sanitizeString('Authorization: Bearer aVerySecretTokenValue123456'))
      .toBe('Authorization: Bearer ***')
  })

  it('is idempotent, so a re-sanitized line does not degrade', () => {
    for (const line of [
      'Authorization: Bearer ***',
      'authorization: ***',
      '{"password":"***"}',
      'cookie: ***',
    ]) {
      expect(sanitizeString(line)).toBe(line)
    }
  })

  /**
   * The patterns run against response bodies chosen by a remote service, so the
   * cost of the scan must not be chosen by it either. A key pattern built as
   * `[\w.-]*(?:token|secret)[\w.-]*` looks harmless and backtracks quadratically:
   * 27ms at the truncation cap, and unbounded without one.
   */
  it('stays fast on input built to make the patterns backtrack', () => {
    const adversarial = `"${'a'.repeat(4_000)}authorization${'a'.repeat(4_000)}`

    const startedAt = performance.now()
    sanitizeString(adversarial)
    const elapsedMs = performance.now() - startedAt

    expect(elapsedMs).toBeLessThan(150)
  })

  it('leaves text carrying no secrets alone', () => {
    const message = 'Discovered 1 partition(s) and 19 sensor(s)'

    expect(sanitizeString(message)).toBe(message)
  })

  it('lets no secret survive a realistic debug log blob', () => {
    const blob = [
      'POST https://www.alarm.com/web/Default.aspx',
      `Cookie: twoFactorAuthenticationId=${TRUST_TOKEN}; ASP.NET_SessionId=${SESSION_ID}`,
      `__VIEWSTATE=${VIEWSTATE}&txtPassword=${PASSWORD}&IsFromNewSite=1`,
      `set-cookie: afg=${CSRF}; path=/; HttpOnly`,
      `ajaxrequestuniquekey: ${CSRF}`,
      `opening wss://webskt.alarm.com:8443?auth=${STREAM_TOKEN}`,
      `{"twoFactorAuthenticationId":"${TRUST_TOKEN}","password":"${PASSWORD}"}`,
    ].join('\n')

    const sanitized = sanitizeString(blob)

    for (const secret of [TRUST_TOKEN, PASSWORD, SESSION_ID, CSRF, VIEWSTATE, STREAM_TOKEN]) {
      expect(sanitized).not.toContain(secret)
    }
    expect(sanitized).toContain('POST https://www.alarm.com/web/Default.aspx')
    expect(sanitized).toContain('opening wss://webskt.alarm.com:8443?auth=***')
  })

  // Regression: these were matched only as `name=value`, so an API error body
  // echoing a live session id was logged verbatim.
  it('redacts session and anti-CSRF values in a JSON body', () => {
    const body = `{"ASP.NET_SessionId":"${SESSION_ID}","afg":"${CSRF}","ajaxrequestuniquekey":"${CSRF}"}`

    const sanitized = sanitizeString(body)

    expect(sanitized).not.toContain(SESSION_ID)
    expect(sanitized).not.toContain(CSRF)
  })

  it('redacts view state carried in a JSON body', () => {
    const sanitized = sanitizeString(`{"__VIEWSTATE":"${VIEWSTATE}"}`)

    expect(sanitized).not.toContain(VIEWSTATE)
  })
})

describe('sanitizeError', () => {
  it('redacts the message of a thrown Error', () => {
    const error = new Error(`login failed with Cookie: afg=${CSRF}`)

    expect(sanitizeError(error)).toBe('login failed with cookie: ***')
  })

  it('redacts a thrown string', () => {
    expect(sanitizeError(`afg=${CSRF}`)).toBe('afg=***')
  })

  it('stringifies and redacts anything else that was thrown', () => {
    expect(sanitizeError({ toString: () => `afg=${CSRF}` })).toBe('afg=***')
    expect(sanitizeError(undefined)).toBe('undefined')
  })

  /**
   * The wrapper is rarely the useful half. "Request failed" wrapping an
   * `ECONNREFUSED` used to log only the first, discarding the one detail that
   * tells an operator what to fix.
   */
  it('includes the underlying cause, which is usually the actionable part', () => {
    const error = new Error('Request to https://www.alarm.com/login failed', {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:443'),
    })

    expect(sanitizeError(error)).toBe(
      'Request to https://www.alarm.com/login failed: connect ECONNREFUSED 127.0.0.1:443',
    )
  })

  it('redacts secrets found in a cause, not just the outer message', () => {
    const error = new Error('login failed', { cause: new Error(`rejected afg=${CSRF}`) })

    expect(sanitizeError(error)).not.toContain(CSRF)
  })

  it('stops walking a cause chain that loops back on itself', () => {
    const inner: Error & { cause?: unknown } = new Error('inner')
    const outer = new Error('outer', { cause: inner })
    inner.cause = outer

    expect(() => sanitizeError(outer)).not.toThrow()
    expect(sanitizeError(outer)).toBe('outer: inner')
  })
})

describe('previewSecret', () => {
  it('describes a secret without disclosing any of it', () => {
    const preview = previewSecret(TRUST_TOKEN)

    // A band, not the exact length: the log needs to distinguish a real token
    // from a truncated paste, not publish one more fact about the credential.
    // Do not assert the digit string of the exact length is absent from the
    // whole preview — the random scrypt fingerprint can collide with it
    // (e.g. length 28 vs `scrypt:…28`), which flakes CI without leaking the
    // credential. The band regex already proves the exact length is not shown.
    expect(preview).toMatch(/^\(20-49 chars, scrypt:[0-9a-f]{8}\)$/)
    expect(preview).not.toContain(TRUST_TOKEN)
    // Not even a fragment. A log is no place to spend a credential's entropy.
    expect(preview).not.toContain(TRUST_TOKEN.slice(-4))
  })

  it('fingerprints consistently, so a changed token is visible as one', () => {
    expect(previewSecret(TRUST_TOKEN)).toBe(previewSecret(TRUST_TOKEN))
    expect(previewSecret(TRUST_TOKEN)).not.toBe(previewSecret(`${TRUST_TOKEN}x`))
  })

  it('says so plainly when there is no secret', () => {
    expect(previewSecret('')).toBe('(none)')
    expect(previewSecret(undefined)).toBe('(none)')
    expect(previewSecret(null)).toBe('(none)')
  })
})

describe('sanitizeUrl', () => {
  it('drops the query string, where Alarm.com puts identifiers and tokens', () => {
    expect(sanitizeUrl(`wss://webskt.alarm.com:8443/?auth=${STREAM_TOKEN}`))
      .toBe('wss://webskt.alarm.com:8443/')
    expect(sanitizeUrl('https://www.alarm.com/web/api/devices/sensors?ids[]=1234567-1'))
      .toBe('https://www.alarm.com/web/api/devices/sensors')
  })

  it('falls back to plain redaction for something that is not a URL', () => {
    expect(sanitizeUrl(`not a url afg=${CSRF}`)).toBe('not a url afg=***')
  })
})
