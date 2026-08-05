/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The jar is deliberately minimal, so what it does with the awkward cases —
 * an emptied cookie, a re-issued one — is the whole of its behaviour.
 */

import { CookieJar } from '../../../src/api/cookie-jar'

function headersWithCookies(...cookies: string[]): Headers {
  const headers = new Headers()
  for (const cookie of cookies) {
    headers.append('set-cookie', cookie)
  }
  return headers
}

describe('CookieJar', () => {
  it('absorbs every Set-Cookie on a response', () => {
    const jar = new CookieJar()

    jar.absorb(headersWithCookies(
      'ASP.NET_SessionId=session-value; path=/; HttpOnly',
      'afg=csrf-value; path=/; secure',
    ))

    expect(jar.get('ASP.NET_SessionId')).toBe('session-value')
    expect(jar.get('afg')).toBe('csrf-value')
    expect(jar.names).toEqual(['ASP.NET_SessionId', 'afg'])
  })

  it('keeps only the cookie value, discarding its attributes', () => {
    const jar = new CookieJar()

    jar.absorb(headersWithCookies('afg=csrf-value; path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT'))

    expect(jar.get('afg')).toBe('csrf-value')
  })

  it('accepts a value containing an equals sign', () => {
    const jar = new CookieJar()

    jar.absorb(headersWithCookies('__VIEWSTATE=abc==; path=/'))

    expect(jar.get('__VIEWSTATE')).toBe('abc==')
  })

  it('treats an emptied cookie as a removal', () => {
    const jar = new CookieJar()
    jar.absorb(headersWithCookies('afg=csrf-value'))

    jar.absorb(headersWithCookies('afg=; path=/'))

    expect(jar.get('afg')).toBeUndefined()
  })

  it('treats the literal "deleted" value as a removal', () => {
    const jar = new CookieJar()
    jar.absorb(headersWithCookies('twoFactorAuthenticationId=trust-token'))

    jar.absorb(headersWithCookies('twoFactorAuthenticationId=deleted; path=/'))

    expect(jar.get('twoFactorAuthenticationId')).toBeUndefined()
  })

  it('lets a later value replace an earlier one', () => {
    const jar = new CookieJar()

    jar.absorb(headersWithCookies('afg=first'))
    jar.absorb(headersWithCookies('afg=second'))

    expect(jar.get('afg')).toBe('second')
  })

  it('skips a malformed Set-Cookie rather than storing nonsense', () => {
    const jar = new CookieJar()

    jar.absorb(headersWithCookies('not-a-cookie'))

    expect(jar.names).toEqual([])
  })

  it('does nothing with a response carrying no cookies', () => {
    const jar = new CookieJar()

    jar.absorb(new Headers())

    expect(jar.names).toEqual([])
    expect(jar.toHeader()).toBe('')
  })

  it('serialises to a Cookie request header', () => {
    const jar = new CookieJar()

    jar.absorb(headersWithCookies('ASP.NET_SessionId=session-value; path=/', 'afg=csrf-value'))

    expect(jar.toHeader()).toBe('ASP.NET_SessionId=session-value; afg=csrf-value')
  })

  it('exposes names without values, which is all that is safe to log', () => {
    const jar = new CookieJar()
    jar.absorb(headersWithCookies('afg=csrf-value', 'twoFactorAuthenticationId=trust-token'))

    expect(jar.names).toEqual(['afg', 'twoFactorAuthenticationId'])
    expect(jar.names.join()).not.toContain('csrf-value')
  })

  it('reports a missing cookie as undefined', () => {
    expect(new CookieJar().get('afg')).toBeUndefined()
    expect(new CookieJar().names).toEqual([])
  })
})
