/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Alarm.com's sign-in is an ASP.NET WebForms postback with two counter-intuitive
 * properties, both of which are asserted here: a 200 means the credentials were
 * rejected, and the cookies set by the login *page* must never be replayed.
 */

import nock from 'nock'
import {
  authenticate,
  buildLoginBody,
  keepAlive,
  scrapeHiddenFields,
  type Credentials,
} from '../../../src/api/auth'
import {
  AuthenticationError,
  LoginFormError,
  TwoFactorRequiredError,
} from '../../../src/errors'
import { BASE_URL, EVENT_FIELD_SENTINEL } from '../../../src/settings'
import { captureRejection } from '../../helpers/errors'
import { createRecordingLogger, messagesAt, type RecordingLogger } from '../../helpers/logger'

const TRUST_TOKEN = 'trust-token-from-a-signed-in-browser'
const SESSION_COOKIE = 'lqzo0hgibbfnbtx5wzcbvsxr'
const CSRF_COOKIE = 'a3f9c1e2b7d4'

const CREDENTIALS: Credentials = {
  username: 'user@example.com',
  password: 'correct-horse-battery',
  twoFactorAuthenticationId: TRUST_TOKEN,
}

function loginPageHtml(fields: Record<string, string> = {}): string {
  const defaults: Record<string, string> = {
    __VIEWSTATE: '/wEPDwUKMTY1NDU2NzIwOWRk',
    __VIEWSTATEGENERATOR: 'CA0B0334',
    __EVENTVALIDATION: '/wEdAAaMcyBQ',
    __PREVIOUSPAGE: 'lTGz0Ka8xLm',
    ...fields,
  }

  const inputs = Object.entries(defaults)
    .map(([name, value]) => `<input type="hidden" name="${name}" id="${name}" value="${value}" />`)
    .join('\n')

  return `<!DOCTYPE html><html><body><form method="post" id="loginform">\n${inputs}\n
    <input name="ctl00$ContentPlaceHolder1$loginform$txtUserName" type="text" />
    <input name="txtPassword" type="password" />
    </form></body></html>`
}

/** The login page GET, which also hands out a cookie that must not be reused. */
function interceptLoginPage(html = loginPageHtml()): void {
  nock(BASE_URL)
    .get('/login')
    .reply(200, html, ['Set-Cookie', 'loginPageOnly=must-not-be-replayed; path=/'])
}

const SUCCESSFUL_LOGIN_COOKIES = [
  'Set-Cookie', `ASP.NET_SessionId=${SESSION_COOKIE}; path=/; HttpOnly`,
  'Set-Cookie', `afg=${CSRF_COOKIE}; path=/`,
]

describe('scrapeHiddenFields', () => {
  it('pulls every hidden WebForms input out of the login page', () => {
    const { found, missing } = scrapeHiddenFields(loginPageHtml())

    expect(missing).toEqual([])
    expect(found).toEqual({
      __VIEWSTATE: '/wEPDwUKMTY1NDU2NzIwOWRk',
      __VIEWSTATEGENERATOR: 'CA0B0334',
      __EVENTVALIDATION: '/wEdAAaMcyBQ',
      __PREVIOUSPAGE: 'lTGz0Ka8xLm',
    })
  })

  it('does not confuse __VIEWSTATE with __VIEWSTATEGENERATOR', () => {
    const { found } = scrapeHiddenFields(loginPageHtml())

    expect(found.__VIEWSTATE).not.toBe(found.__VIEWSTATEGENERATOR)
  })

  it('reports which fields were missing rather than stopping at the first', () => {
    const html = loginPageHtml()
      .replace(/<input[^>]*name="__EVENTVALIDATION"[^>]*>/, '')
      .replace(/<input[^>]*name="__PREVIOUSPAGE"[^>]*>/, '')

    const { found, missing } = scrapeHiddenFields(html)

    expect(missing).toEqual(['__EVENTVALIDATION', '__PREVIOUSPAGE'])
    expect(Object.keys(found)).toEqual(['__VIEWSTATE', '__VIEWSTATEGENERATOR'])
  })

  it('accepts an empty value, which WebForms does emit', () => {
    const { found, missing } = scrapeHiddenFields(loginPageHtml({ __PREVIOUSPAGE: '' }))

    expect(missing).toEqual([])
    expect(found.__PREVIOUSPAGE).toBe('')
  })

  it('finds nothing in a page that is not the login form', () => {
    expect(scrapeHiddenFields('<html><body>Service unavailable</body></html>').missing).toHaveLength(4)
  })
})

describe('buildLoginBody', () => {
  const hiddenFields = { __VIEWSTATE: 'view-state-value', __VIEWSTATEGENERATOR: 'CA0B0334' }

  it('sends the three __EVENT fields as the literal string "null"', () => {
    const body = buildLoginBody('user@example.com', 'secret', hiddenFields)

    expect(body.get('__EVENTTARGET')).toBe('null')
    expect(body.get('__EVENTARGUMENT')).toBe('null')
    expect(body.get('__VIEWSTATEENCRYPTED')).toBe('null')
    expect(EVENT_FIELD_SENTINEL).toBe('null')
  })

  it('echoes the scraped hidden fields back', () => {
    const body = buildLoginBody('user@example.com', 'secret', hiddenFields)

    expect(body.get('__VIEWSTATE')).toBe('view-state-value')
    expect(body.get('__VIEWSTATEGENERATOR')).toBe('CA0B0334')
  })

  it('carries the credentials in the fields Alarm.com expects', () => {
    const body = buildLoginBody('user@example.com', 'secret', hiddenFields)

    expect(body.get('ctl00$ContentPlaceHolder1$loginform$txtUserName')).toBe('user@example.com')
    expect(body.get('txtPassword')).toBe('secret')
    expect(body.get('IsFromNewSite')).toBe('1')
  })
})

describe('authenticate', () => {
  let log: RecordingLogger

  beforeEach(() => {
    log = createRecordingLogger()
  })

  it('returns a session when Alarm.com redirects after the postback', async () => {
    interceptLoginPage()
    nock(BASE_URL).post('/web/Default.aspx').reply(302, '', SUCCESSFUL_LOGIN_COOKIES)

    const session = await authenticate(CREDENTIALS, log)

    expect(session.ajaxKey).toBe(CSRF_COOKIE)
    expect(session.cookieHeader).toContain(`ASP.NET_SessionId=${SESSION_COOKIE}`)
    expect(session.createdAt).toBeInstanceOf(Date)
  })

  it('replays only the cookies from the login POST, never those from the login page', async () => {
    interceptLoginPage()
    nock(BASE_URL).post('/web/Default.aspx').reply(302, '', SUCCESSFUL_LOGIN_COOKIES)

    const session = await authenticate(CREDENTIALS, log)

    expect(session.cookieHeader).toBe(`ASP.NET_SessionId=${SESSION_COOKIE}; afg=${CSRF_COOKIE}`)
    expect(session.cookieHeader).not.toContain('loginPageOnly')
  })

  it('sends the configured trust token with the postback', async () => {
    let sentCookie: string | undefined
    interceptLoginPage()
    nock(BASE_URL).post('/web/Default.aspx').reply(302, function (this: nock.ReplyFnContext) {
      sentCookie = this.req.headers.cookie
      return ''
    }, SUCCESSFUL_LOGIN_COOKIES)

    await authenticate(CREDENTIALS, log)

    expect(sentCookie).toBe(`twoFactorAuthenticationId=${TRUST_TOKEN}`)
  })

  it('sends no cookie at all when no trust token is configured', async () => {
    let sentCookie: string | undefined
    interceptLoginPage()
    nock(BASE_URL).post('/web/Default.aspx').reply(302, function (this: nock.ReplyFnContext) {
      sentCookie = this.req.headers.cookie
      return ''
    }, SUCCESSFUL_LOGIN_COOKIES)

    await authenticate({ ...CREDENTIALS, twoFactorAuthenticationId: '' }, log)

    expect(sentCookie).toBeUndefined()
  })

  it('posts the scraped hidden fields and the credentials', async () => {
    let postedBody = ''
    interceptLoginPage()
    nock(BASE_URL).post('/web/Default.aspx').reply(302, (_uri, body) => {
      postedBody = String(body)
      return ''
    }, SUCCESSFUL_LOGIN_COOKIES)

    await authenticate(CREDENTIALS, log)
    const posted = new URLSearchParams(postedBody)

    expect(posted.get('__VIEWSTATE')).toBe('/wEPDwUKMTY1NDU2NzIwOWRk')
    expect(posted.get('ctl00$ContentPlaceHolder1$loginform$txtUserName')).toBe(CREDENTIALS.username)
    expect(posted.get('txtPassword')).toBe(CREDENTIALS.password)
  })

  it('treats a 200 as a rejected credential, because WebForms re-renders the form', async () => {
    interceptLoginPage()
    nock(BASE_URL).post('/web/Default.aspx').reply(200, loginPageHtml())

    const error = await captureRejection(authenticate(CREDENTIALS, log))

    expect(error).toBeInstanceOf(AuthenticationError)
    expect(error.message).toMatch(/rejected the username or password/)
    expect(error.message).toMatch(/lock the account/)
  })

  it('raises a two-factor error on a 409', async () => {
    interceptLoginPage()
    nock(BASE_URL).post('/web/Default.aspx').reply(409, '{"errors":["TwoFactorAuthenticationRequired"]}')

    await expect(authenticate(CREDENTIALS, log)).rejects.toThrow(TwoFactorRequiredError)
  })

  it('raises a login form error when the sign-in page no longer has the fields', async () => {
    interceptLoginPage(loginPageHtml().replace(/<input[^>]*name="__VIEWSTATE"[^>]*>/, ''))

    const error = await captureRejection(authenticate(CREDENTIALS, log))

    expect(error).toBeInstanceOf(LoginFormError)
    expect(error.message).toContain('__VIEWSTATE')
    expect(error.message).toMatch(/this plugin needs an update/)
  })

  it('raises an authentication error when the redirect carries no anti-CSRF cookie', async () => {
    interceptLoginPage()
    nock(BASE_URL)
      .post('/web/Default.aspx')
      .reply(302, '', ['Set-Cookie', `ASP.NET_SessionId=${SESSION_COOKIE}; path=/`])

    await expect(authenticate(CREDENTIALS, log)).rejects.toThrow(/did not return the "afg" cookie/)
  })

  it('warns when Alarm.com hands back a trust token different from the configured one', async () => {
    interceptLoginPage()
    nock(BASE_URL).post('/web/Default.aspx').reply(302, '', [
      ...SUCCESSFUL_LOGIN_COOKIES,
      'Set-Cookie', 'twoFactorAuthenticationId=a-brand-new-token; path=/',
    ])

    await authenticate(CREDENTIALS, log)

    expect(messagesAt(log, 'warn').join('\n')).toMatch(/issued a new two-factor trust token/)
  })

  it('stays quiet when Alarm.com echoes back the configured trust token', async () => {
    interceptLoginPage()
    nock(BASE_URL).post('/web/Default.aspx').reply(302, '', [
      ...SUCCESSFUL_LOGIN_COOKIES,
      'Set-Cookie', `twoFactorAuthenticationId=${TRUST_TOKEN}; path=/`,
    ])

    await authenticate(CREDENTIALS, log)

    expect(log.warn).not.toHaveBeenCalled()
  })

  it('logs the cookie names and a fingerprint of the token, never the values', async () => {
    interceptLoginPage()
    nock(BASE_URL).post('/web/Default.aspx').reply(302, '', SUCCESSFUL_LOGIN_COOKIES)

    await authenticate(CREDENTIALS, log)
    const debugOutput = messagesAt(log, 'debug').join('\n')

    expect(debugOutput).toContain('afg')
    expect(debugOutput).not.toContain(CSRF_COOKIE)
    expect(debugOutput).not.toContain(TRUST_TOKEN)
    expect(debugOutput).toContain(`${TRUST_TOKEN.length} chars`)
  })
})

describe('keepAlive', () => {
  const session = { cookieHeader: `afg=${CSRF_COOKIE}`, ajaxKey: CSRF_COOKIE, createdAt: new Date() }

  it('reports the session alive on a 200', async () => {
    nock(BASE_URL)
      .matchHeader('cookie', session.cookieHeader)
      .matchHeader('ajaxrequestuniquekey', session.ajaxKey)
      .get('/web/KeepAlive.aspx')
      .reply(200, '{"status":200}')

    await expect(keepAlive(session)).resolves.toBe(true)
  })

  it('reports the session dead on anything else', async () => {
    nock(BASE_URL).get('/web/KeepAlive.aspx').reply(302, '')

    await expect(keepAlive(session)).resolves.toBe(false)
  })
})
