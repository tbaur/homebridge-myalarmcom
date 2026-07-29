/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Minimal Alarm.com web-session client for development scripts.
 *
 * Alarm.com publishes no consumer API. The browser signs in through an ASP.NET
 * WebForms postback and then calls a JSON:API surface using the resulting
 * session cookies plus an anti-CSRF value echoed back in a custom header. This
 * module reproduces exactly that, and nothing more.
 *
 * Development tooling, not plugin code. It deliberately reimplements the login
 * flow rather than importing `dist/`, so `probe.mjs` can still discover the
 * protocol when the shipping client is the thing that broke.
 */

import { createHash } from 'node:crypto'

/** Root of the Alarm.com web application. */
export const BASE_URL = 'https://www.alarm.com'

/** Page whose HTML carries the hidden WebForms fields required to post a login. */
export const LOGIN_PAGE_URL = `${BASE_URL}/login`

/** WebForms postback target that actually authenticates the credentials. */
export const LOGIN_POST_URL = `${BASE_URL}/web/Default.aspx`

/** Returns the signed-in user, their systems, and account-level preferences. */
export const IDENTITIES_URL = `${BASE_URL}/web/api/identities`

/**
 * Alarm.com rejects JSON:API calls that do not look like they came from the
 * web app, so every authenticated request carries this as `Referer`.
 */
export const HOME_REFERER = `${BASE_URL}/web/system/home`

/** The only domain the session cookies may be sent to. */
const ALARM_COM_HOST_SUFFIX = '.alarm.com'

/**
 * Whether a URL is somewhere the cookie jar may be sent.
 *
 * The jar holds the session cookies and the two-factor bypass token, so this
 * is checked before any request that carries it to a server-chosen location.
 */
export function isAlarmComUrl(value) {
  return hasAlarmComOrigin(value, 'https:')
}

/** As {@link isAlarmComUrl}, for the `wss:` event stream endpoint. */
export function isWebSocketUrl(value) {
  return hasAlarmComOrigin(value, 'wss:')
}

function hasAlarmComOrigin(value, expectedProtocol) {
  try {
    const { protocol, hostname } = new URL(value)
    return protocol === expectedProtocol
      && (hostname === 'alarm.com' || hostname.endsWith(ALARM_COM_HOST_SUFFIX))
  } catch {
    return false
  }
}

/**
 * Hidden inputs that must be echoed back on the login postback. If Alarm.com
 * reworks its login page these are the first things to break, so the scraper
 * reports which ones it found rather than throwing on the first miss.
 */
export const LOGIN_FORM_FIELDS = ['__VIEWSTATE', '__VIEWSTATEGENERATOR', '__EVENTVALIDATION', '__PREVIOUSPAGE']

/** Hard ceiling on any single request. Never wait on Alarm.com indefinitely. */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * Minimum spacing between requests. Alarm.com is known to lock accounts that
 * authenticate or poll aggressively, and a discovery sweep is exactly the kind
 * of traffic that looks abusive. Slow is correct here.
 */
const THROTTLE_MS = 1_500

/** Identifies this tool honestly rather than impersonating a browser. */
const USER_AGENT = 'homebridge-myalarmcom-probe/0.1.0'

let lastRequestAt = 0

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Space out requests so a discovery run cannot look like an attack. */
async function throttle() {
  const waitMs = THROTTLE_MS - (Date.now() - lastRequestAt)
  if (waitMs > 0) {await sleep(waitMs)}
  lastRequestAt = Date.now()
}

/** Throttled `fetch` with a hard timeout and a consistent User-Agent. */
export async function request(url, init = {}) {
  await throttle()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, {
      redirect: 'manual',
      ...init,
      headers: { 'User-Agent': USER_AGENT, ...init.headers },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Render a secret as a short, non-reversible hint. Used so terminal output can
 * confirm "yes, we got a token" without putting the token on screen or into a
 * scrollback buffer.
 *
 * A hash, not a prefix. The previous four-character slice bought no diagnostic
 * power a fingerprint does not, and these previews are written to `summary.json`
 * and to a terminal, both of which end up pasted into issue trackers. The
 * secret being described is the two-factor bypass token.
 */
export function previewSecret(value) {
  if (!value) {return '(absent)'}
  const fingerprint = createHash('sha256').update(value).digest('hex').slice(0, 8)
  return `sha256:${fingerprint} (${value.length} chars)`
}

/** Accumulates `Set-Cookie` values across a login exchange. */
export class CookieJar {
  #cookies = new Map()

  /** Merge every `Set-Cookie` on a response into the jar. */
  absorb(response) {
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';')
      const separator = pair.indexOf('=')
      if (separator === -1) {continue}
      const name = pair.slice(0, separator).trim()
      const value = pair.slice(separator + 1).trim()
      // Alarm.com clears cookies by re-issuing them empty; treat that as a delete
      // so a stale value cannot outlive the server's intent.
      if (value === '' || value === 'deleted') {
        this.#cookies.delete(name)
        continue
      }
      this.#cookies.set(name, value)
    }
  }

  get(name) {
    return this.#cookies.get(name)
  }

  /** Cookie names only. Safe to log; values never are. */
  get names() {
    return [...this.#cookies.keys()]
  }

  /** Serialized `Cookie` request header. */
  get header() {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }
}

/**
 * Pull the hidden WebForms inputs out of the login page HTML.
 *
 * Returns both what was found and what was missing: a missing field means
 * Alarm.com changed its login form, which is far more useful to report than a
 * generic "login failed" further down.
 */
export function scrapeHiddenFields(html) {
  const found = {}
  const missing = []
  for (const name of LOGIN_FORM_FIELDS) {
    const match = new RegExp(`name="${name}"[\\s\\S]*?value="([^"]*)"`).exec(html)
    if (match) {found[name] = match[1]}
    else {missing.push(name)}
  }
  return { found, missing }
}

/**
 * Build the login postback body.
 *
 * The three `__EVENT*` values are sent as the literal string `"null"`. That is
 * not a bug: it is what the long-running community client sends and what the
 * endpoint demonstrably accepts today. Against an undocumented black box,
 * matching known-working bytes beats sending what "should" be correct.
 */
export function buildLoginBody({ username, password, hiddenFields }) {
  return new URLSearchParams({
    __EVENTTARGET: 'null',
    __EVENTARGUMENT: 'null',
    __VIEWSTATEENCRYPTED: 'null',
    ...hiddenFields,
    IsFromNewSite: '1',
    'ctl00$ContentPlaceHolder1$loginform$txtUserName': username,
    txtPassword: password,
  })
}

/**
 * Establish a signed-in session.
 *
 * @returns {Promise<{jar: CookieJar, ajaxKey: string|undefined, diagnostics: object}>}
 *   The caller inspects `diagnostics` to distinguish "wrong password" from
 *   "Alarm.com changed the login form" from "MFA required".
 */
export async function login({ username, password, mfaToken }) {
  const pageResponse = await request(LOGIN_PAGE_URL, { method: 'GET' })
  const html = await pageResponse.text()
  const { found: hiddenFields, missing } = scrapeHiddenFields(html)

  // Two jars, because which cookies you replay materially changes the outcome.
  // `loginJar` holds only what the login POST returned, which is exactly what
  // the long-running community client sends on API calls. `jar` additionally
  // carries cookies picked up from the login page. Keeping them separate lets
  // callers A/B the two rather than guess.
  const jar = new CookieJar()
  const loginJar = new CookieJar()
  jar.absorb(pageResponse)

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
  // Only send the trust cookie when we actually have one. The community client
  // always sends it, so accounts without MFA transmit the literal "undefined".
  if (mfaToken) {headers.Cookie = `twoFactorAuthenticationId=${mfaToken}`}

  const loginResponse = await request(LOGIN_POST_URL, {
    method: 'POST',
    headers,
    body: buildLoginBody({ username, password, hiddenFields }),
  })
  jar.absorb(loginResponse)
  loginJar.absorb(loginResponse)

  const ajaxKey = loginJar.get('afg') ?? jar.get('afg')
  const returnedMfaToken = loginJar.get('twoFactorAuthenticationId')
  const diagnostics = {
    mfaTokenSent: Boolean(mfaToken),
    mfaTokenSentPreview: previewSecret(mfaToken),
    mfaTokenReturnedPreview: previewSecret(returnedMfaToken),
    // If Alarm.com hands back a different trust token than the one we sent, the
    // one we sent was not accepted -- that is the whole ballgame for a 409.
    mfaTokenReplaced: Boolean(mfaToken && returnedMfaToken && returnedMfaToken !== mfaToken),
    loginPageStatus: pageResponse.status,
    hiddenFieldsFound: Object.keys(hiddenFields),
    hiddenFieldsMissing: missing,
    loginStatus: loginResponse.status,
    loginRedirect: loginResponse.headers.get('location') ?? null,
    cookieNames: jar.names,
    hasAjaxKey: Boolean(ajaxKey),
    // A 200 means the form re-rendered instead of redirecting, which is how a
    // WebForms login reports failure.
    likelyRejected: loginResponse.status === 200,
    mfaRequired: loginResponse.status === 409,
  }

  return { jar, loginJar, ajaxKey, diagnostics }
}

/**
 * Follow the post-login redirect chain the way a browser would.
 *
 * Signing in lands on `DetermineLandingPage.aspx`, which redirects on to the
 * system dashboard. Parts of the JSON:API surface appear to need the session
 * context that this chain establishes, so a client that stops at the first 302
 * can hold a valid session and still be refused by some routes.
 *
 * Every hop is a GET, so this cannot change any device state.
 *
 * Each hop is checked to be TLS on an Alarm.com host before the cookie jar is
 * sent to it. The jar holds the session and the two-factor bypass token, and
 * `Location` is chosen by the server, so following it unchecked would let one
 * response header redirect a full set of credentials to any host it liked.
 */
export async function followRedirects(jar, startPath, maxHops = 5) {
  const hops = []
  let target = new URL(startPath, BASE_URL).href

  for (let hop = 0; hop < maxHops; hop++) {
    if (!isAlarmComUrl(target)) {
      hops.push({ path: target, status: null, location: null, refused: 'off-site redirect' })
      break
    }

    const response = await request(target, {
      method: 'GET',
      headers: { Cookie: jar.header, Referer: HOME_REFERER },
    })
    jar.absorb(response)

    const location = response.headers.get('location')
    // Paths only: redirect query strings can carry account identifiers, and
    // these hops are recorded in the run summary.
    hops.push({
      path: new URL(target).pathname,
      status: response.status,
      location: location ? new URL(location, BASE_URL).pathname : null,
    })
    if (!location || response.status < 300 || response.status >= 400) {break}
    target = new URL(location, BASE_URL).href
  }

  return hops
}

/** Issue an authenticated JSON:API GET and return status plus parsed body. */
export async function authenticatedGet(url, { jar, ajaxKey }) {
  const response = await request(url, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.api+json',
      Cookie: jar.header,
      ajaxrequestuniquekey: ajaxKey ?? '',
      Referer: HOME_REFERER,
    },
  })

  const contentType = response.headers.get('content-type') ?? ''
  const isJson = contentType.includes('json')
  let body = null
  try {
    body = isJson ? await response.json() : await response.text()
  } catch {
    body = null
  }

  return {
    status: response.status,
    contentType,
    isJson,
    body,
    // Recorded so a redirected API call is distinguishable from a rejected one.
    location: response.headers.get('location'),
  }
}
