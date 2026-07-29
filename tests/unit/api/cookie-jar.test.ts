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

function responseWithCookies(...cookies: string[]): Response {
  const headers = new Headers()
  for (const cookie of cookies) {
    headers.append('set-cookie', cookie)
  }
  return new Response(null, { status: 302, headers })
}

describe('CookieJar', () => {
  it('absorbs every Set-Cookie on a response', () => {
    const jar = new CookieJar()

    jar.absorb(responseWithCookies(
      'ASP.NET_SessionId=session-value; path=/; HttpOnly',
      'afg=csrf-value; path=/; secure',
    ))

    expect(jar.get('ASP.NET_SessionId')).toBe('session-value')
    expect(jar.get('afg')).toBe('csrf-value')
    expect(jar.size).toBe(2)
  })

  it('keeps only the cookie value, discarding its attributes', () => {
    const jar = new CookieJar()

    jar.absorb(responseWithCookies('afg=csrf-value; path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT'))

    expect(jar.get('afg')).toBe('csrf-value')
  })

  it('accepts a value containing an equals sign', () => {
    const jar = new CookieJar()

    jar.absorb(responseWithCookies('__VIEWSTATE=abc==; path=/'))

    expect(jar.get('__VIEWSTATE')).toBe('abc==')
  })

  it('treats an emptied cookie as a removal', () => {
    const jar = new CookieJar()
    jar.set('afg', 'csrf-value')

    jar.absorb(responseWithCookies('afg=; path=/'))

    expect(jar.has('afg')).toBe(false)
  })

  it('treats the literal "deleted" value as a removal', () => {
    const jar = new CookieJar()
    jar.set('twoFactorAuthenticationId', 'trust-token')

    jar.absorb(responseWithCookies('twoFactorAuthenticationId=deleted; path=/'))

    expect(jar.has('twoFactorAuthenticationId')).toBe(false)
  })

  it('lets a later value replace an earlier one', () => {
    const jar = new CookieJar()

    jar.absorb(responseWithCookies('afg=first'))
    jar.absorb(responseWithCookies('afg=second'))

    expect(jar.get('afg')).toBe('second')
  })

  it('skips a malformed Set-Cookie rather than storing nonsense', () => {
    const jar = new CookieJar()

    jar.absorb(responseWithCookies('not-a-cookie'))

    expect(jar.size).toBe(0)
  })

  it('does nothing with a response carrying no cookies', () => {
    const jar = new CookieJar()

    jar.absorb(new Response(null, { status: 200 }))

    expect(jar.size).toBe(0)
    expect(jar.toHeader()).toBe('')
  })

  it('serialises to a Cookie request header', () => {
    const jar = new CookieJar()

    jar.absorb(responseWithCookies('ASP.NET_SessionId=session-value; path=/', 'afg=csrf-value'))

    expect(jar.toHeader()).toBe('ASP.NET_SessionId=session-value; afg=csrf-value')
  })

  it('exposes names without values, which is all that is safe to log', () => {
    const jar = new CookieJar()
    jar.set('afg', 'csrf-value')
    jar.set('twoFactorAuthenticationId', 'trust-token')

    expect(jar.names).toEqual(['afg', 'twoFactorAuthenticationId'])
    expect(jar.names.join()).not.toContain('csrf-value')
  })

  it('reports a missing cookie as undefined', () => {
    expect(new CookieJar().get('afg')).toBeUndefined()
    expect(new CookieJar().has('afg')).toBe(false)
  })
})
