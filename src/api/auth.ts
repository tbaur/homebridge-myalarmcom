/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Alarm.com authentication and session lifecycle.
 *
 * Alarm.com has no consumer API. A browser signs in through an ASP.NET WebForms
 * postback and then calls a JSON:API surface using the resulting session cookies
 * plus an anti-CSRF value echoed back in a custom header. This module reproduces
 * exactly that and nothing more.
 */

import {
  AuthenticationError,
  LoginFormError,
  TwoFactorRequiredError,
} from '../errors'
import {
  CSRF_COOKIE_NAME,
  EVENT_FIELD_SENTINEL,
  KEEPALIVE_URL,
  LOGIN_FORM_FIELDS,
  LOGIN_PAGE_URL,
  LOGIN_POST_URL,
  MFA_COOKIE_NAME,
  PASSWORD_FIELD,
  USERNAME_FIELD,
} from '../settings'
import type { Logger } from '../utils/logger'
import { previewSecret } from '../utils/sanitizers'
import { CookieJar } from './cookie-jar'
import { httpRequest } from './http'

/** Credentials needed to establish a session. */
export interface Credentials {
  username: string
  password: string
  /** The `twoFactorAuthenticationId` cookie value, or empty if 2FA is off. */
  twoFactorAuthenticationId: string
}

/** An authenticated Alarm.com web session. */
export interface Session {
  /** Serialized `Cookie` header to replay on every API request. */
  cookieHeader: string
  /** Anti-CSRF value for the `ajaxrequestuniquekey` header. */
  ajaxKey: string
  /** When this session was established. */
  createdAt: Date
}

/** Result of scraping the login page. */
interface HiddenFields {
  found: Record<string, string>
  missing: string[]
}

/**
 * Pull the hidden WebForms inputs out of the login page HTML.
 *
 * Reports what was missing rather than throwing on the first absent field,
 * because "Alarm.com changed its login form" is a far more actionable diagnosis
 * than a generic failure further downstream.
 */
export function scrapeHiddenFields(html: string): HiddenFields {
  const found: Record<string, string> = {}
  const missing: string[] = []

  for (const name of LOGIN_FORM_FIELDS) {
    const match = new RegExp(`name="${name}"[\\s\\S]*?value="([^"]*)"`).exec(html)
    if (match) {
      found[name] = match[1]
    } else {
      missing.push(name)
    }
  }

  return { found, missing }
}

/**
 * Build the login postback body.
 *
 * The three `__EVENT*` values are sent as the literal string `"null"`. That is
 * not a bug: it is what Alarm.com's endpoint demonstrably accepts today.
 * Against an undocumented service, matching known-working bytes beats sending
 * what ought to be correct.
 */
export function buildLoginBody(
  username: string,
  password: string,
  hiddenFields: Record<string, string>,
): URLSearchParams {
  return new URLSearchParams({
    __EVENTTARGET: EVENT_FIELD_SENTINEL,
    __EVENTARGUMENT: EVENT_FIELD_SENTINEL,
    __VIEWSTATEENCRYPTED: EVENT_FIELD_SENTINEL,
    ...hiddenFields,
    IsFromNewSite: '1',
    [USERNAME_FIELD]: username,
    [PASSWORD_FIELD]: password,
  })
}

/**
 * Establish a signed-in session.
 *
 * Only the cookies returned by the login POST are kept. Cookies picked up from
 * the login page beforehand are deliberately discarded: replaying the full set
 * was tested against a live account and Alarm.com rejected it with a two-factor
 * challenge, while the login-response set alone was accepted. This is the one
 * non-obvious detail that makes the whole flow work.
 *
 * @throws {LoginFormError} The login page could not be parsed.
 * @throws {TwoFactorRequiredError} Alarm.com demanded two-factor verification.
 * @throws {AuthenticationError} The credentials were rejected.
 */
export async function authenticate(
  credentials: Credentials,
  log: Logger,
): Promise<Session> {
  const pageResponse = await httpRequest(LOGIN_PAGE_URL)
  const html = await pageResponse.text()
  const { found: hiddenFields, missing } = scrapeHiddenFields(html)

  if (missing.length > 0) {
    throw new LoginFormError(
      `Could not find the login form fields ${missing.join(', ')}. Alarm.com may have changed its sign-in page; this plugin needs an update.`,
    )
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  }

  // Only send the trust cookie when there is one. Sending the literal string
  // "undefined" is worse than sending nothing.
  if (credentials.twoFactorAuthenticationId) {
    headers.Cookie = `${MFA_COOKIE_NAME}=${credentials.twoFactorAuthenticationId}`
  }

  const loginResponse = await httpRequest(LOGIN_POST_URL, {
    method: 'POST',
    headers,
    body: buildLoginBody(credentials.username, credentials.password, hiddenFields),
  })

  const jar = new CookieJar()
  jar.absorb(loginResponse)

  log.debug(
    `login responded ${loginResponse.status} with cookies [${jar.names.join(', ')}], sent trust token ${previewSecret(credentials.twoFactorAuthenticationId)}`,
  )

  if (loginResponse.status === 409) {
    throw new TwoFactorRequiredError()
  }

  // A WebForms login reports failure by re-rendering the form with a 200 rather
  // than redirecting, so success is the redirect and 200 is the error case.
  if (loginResponse.status === 200) {
    throw new AuthenticationError(
      'Alarm.com rejected the username or password. Note that repeated failures will lock the account.',
    )
  }

  const ajaxKey = jar.get(CSRF_COOKIE_NAME)
  if (!ajaxKey) {
    throw new AuthenticationError(
      `Signed in but Alarm.com did not return the "${CSRF_COOKIE_NAME}" cookie needed to call its API.`,
    )
  }

  // If Alarm.com hands back a *different* trust token than the one supplied,
  // the supplied one was not honoured. Surfacing this early turns an eventual
  // mystery 409 into a clear warning.
  const returnedTrustToken = jar.get(MFA_COOKIE_NAME)
  if (
    credentials.twoFactorAuthenticationId
    && returnedTrustToken
    && returnedTrustToken !== credentials.twoFactorAuthenticationId
  ) {
    log.warn(
      'Alarm.com issued a new two-factor trust token, which means the configured one was not accepted. Re-copy the cookie from a signed-in browser if requests start failing.',
    )
  }

  return {
    cookieHeader: jar.toHeader(),
    ajaxKey,
    createdAt: new Date(),
  }
}

/**
 * Touch the session so Alarm.com keeps it alive.
 *
 * Materially safer than re-authenticating: signing in is the request Alarm.com
 * polices for abuse, so refreshing an existing session avoids the operation
 * most likely to lock the account.
 *
 * @returns Whether the session is still valid.
 */
export async function keepAlive(session: Session): Promise<boolean> {
  const response = await httpRequest(KEEPALIVE_URL, {
    headers: {
      Cookie: session.cookieHeader,
      ajaxrequestuniquekey: session.ajaxKey,
    },
  })

  return response.status === 200
}
