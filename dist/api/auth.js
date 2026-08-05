"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.scrapeHiddenFields = scrapeHiddenFields;
exports.buildLoginBody = buildLoginBody;
exports.authenticate = authenticate;
exports.keepAlive = keepAlive;
const errors_1 = require("../errors");
const settings_1 = require("../settings");
const sanitizers_1 = require("../utils/sanitizers");
const cookie_jar_1 = require("./cookie-jar");
const http_1 = require("./http");
/**
 * One compiled pattern per hidden field, built once at module load.
 *
 * Scoped to a single tag with `[^>]*`. The earlier unbounded `[\s\S]*?` would
 * skip past an input that had no adjacent `value=` and capture some *other*
 * field's value, so a layout change looked like success with the wrong bytes —
 * defeating the missing-field detection that exists to make such a change
 * diagnosable.
 */
const HIDDEN_FIELD_PATTERNS = settings_1.LOGIN_FORM_FIELDS.map((name) => [name, new RegExp(`name="${name}"[^>]*?value="([^"]*)"`)]);
/**
 * Pull the hidden WebForms inputs out of the login page HTML.
 *
 * Reports what was missing rather than throwing on the first absent field,
 * because "Alarm.com changed its login form" is a far more actionable diagnosis
 * than a generic failure further downstream.
 */
function scrapeHiddenFields(html) {
    const found = {};
    const missing = [];
    for (const [name, pattern] of HIDDEN_FIELD_PATTERNS) {
        const value = pattern.exec(html)?.[1];
        if (value === undefined) {
            missing.push(name);
        }
        else {
            found[name] = value;
        }
    }
    return { found, missing };
}
/**
 * Build the login postback body.
 *
 * The three `__EVENT*` values are sent as the literal string `"null"`. That is
 * not a bug: it is what Alarm.com's endpoint demonstrably accepts today.
 * Against an undocumented service, matching known-working bytes beats sending
 * what ought to be correct.
 */
function buildLoginBody(username, password, hiddenFields) {
    return new URLSearchParams({
        __EVENTTARGET: settings_1.EVENT_FIELD_SENTINEL,
        __EVENTARGUMENT: settings_1.EVENT_FIELD_SENTINEL,
        __VIEWSTATEENCRYPTED: settings_1.EVENT_FIELD_SENTINEL,
        ...hiddenFields,
        [settings_1.IS_FROM_NEW_SITE_FIELD]: '1',
        [settings_1.USERNAME_FIELD]: username,
        [settings_1.PASSWORD_FIELD]: password,
    });
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
 * @param signal Cancels both requests when the platform shuts down.
 * @throws {LoginFormError} The login page could not be parsed.
 * @throws {TwoFactorRequiredError} Alarm.com demanded two-factor verification.
 * @throws {AuthenticationError} The credentials were rejected.
 */
async function authenticate(credentials, log, signal) {
    const pageResponse = await (0, http_1.httpRequest)(settings_1.LOGIN_PAGE_URL, {
        timeoutMs: settings_1.LOGIN_REQUEST_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
    });
    // Checked before scraping. A 503 maintenance page or a bot-check interstitial
    // has no `__VIEWSTATE` either, and reporting that as "Alarm.com changed its
    // sign-in page" is both wrong and permanent: LoginFormError is classified as
    // needing a human, so a ten-second blip that coincided with a restart used to
    // disable the plugin until someone noticed — and sent them looking for an
    // update that does not exist.
    if (!pageResponse.ok) {
        throw (0, errors_1.createApiError)(pageResponse.status, `Alarm.com returned ${pageResponse.status} for its sign-in page`, { body: pageResponse.text });
    }
    const { found: hiddenFields, missing } = scrapeHiddenFields(pageResponse.text);
    if (missing.length > 0) {
        throw new errors_1.LoginFormError(`Could not find the login form fields ${missing.join(', ')}. Alarm.com may have changed its sign-in page; this plugin needs an update.`);
    }
    const loginResponse = await (0, http_1.httpRequest)(settings_1.LOGIN_POST_URL, {
        method: 'POST',
        headers: buildLoginHeaders(credentials),
        body: buildLoginBody(credentials.username, credentials.password, hiddenFields),
        timeoutMs: settings_1.LOGIN_REQUEST_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
    });
    const jar = new cookie_jar_1.CookieJar();
    jar.absorb(loginResponse.headers);
    if (log.isDebugEnabled) {
        log.debug(`login responded ${loginResponse.status} with cookies [${jar.names.join(', ')}], sent trust token ${(0, sanitizers_1.previewSecret)(credentials.twoFactorAuthenticationId)}`);
    }
    assertLoginSucceeded(loginResponse.status);
    const ajaxKey = jar.get(settings_1.CSRF_COOKIE_NAME);
    if (!ajaxKey) {
        throw new errors_1.AuthenticationError(`Signed in but Alarm.com did not return the "${settings_1.CSRF_COOKIE_NAME}" cookie needed to call its API.`);
    }
    warnOnReplacedTrustToken(credentials, jar.get(settings_1.MFA_COOKIE_NAME), log);
    return {
        cookieHeader: jar.toHeader(),
        ajaxKey,
    };
}
/** Headers for the login postback, including the trust cookie when there is one. */
function buildLoginHeaders(credentials) {
    const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
    };
    // Only send the trust cookie when there is one. Sending the literal string
    // "undefined" is worse than sending nothing.
    if (credentials.twoFactorAuthenticationId) {
        headers.Cookie = `${settings_1.MFA_COOKIE_NAME}=${credentials.twoFactorAuthenticationId}`;
    }
    return headers;
}
/**
 * Turn a login status into the right error, or return for success.
 *
 * A WebForms login reports failure by re-rendering the form with a 200 rather
 * than redirecting, so success is the redirect and 200 is the error case.
 */
function assertLoginSucceeded(status) {
    if (status === 409) {
        throw new errors_1.TwoFactorRequiredError();
    }
    if (status === 200) {
        throw new errors_1.AuthenticationError('Alarm.com rejected the username or password. Note that repeated failures will lock the account.');
    }
}
/**
 * Warn when Alarm.com hands back a different trust token than the one supplied.
 *
 * That means the supplied one was not honoured. Surfacing it early turns an
 * eventual mystery 409 into a clear warning while the plugin still works.
 */
function warnOnReplacedTrustToken(credentials, returnedTrustToken, log) {
    if (credentials.twoFactorAuthenticationId
        && returnedTrustToken
        && returnedTrustToken !== credentials.twoFactorAuthenticationId) {
        log.warn('Alarm.com issued a new two-factor trust token, which means the configured one was not accepted. Re-copy the cookie from a signed-in browser if requests start failing.');
    }
}
/**
 * Touch the session so Alarm.com keeps it alive.
 *
 * Materially safer than re-authenticating: signing in is the request Alarm.com
 * polices for abuse, so refreshing an existing session avoids the operation
 * most likely to lock the account.
 *
 * @param signal Cancels the probe when the platform shuts down.
 * @returns Whether the session is still valid.
 */
async function keepAlive(session, signal) {
    const response = await (0, http_1.httpRequest)(settings_1.KEEPALIVE_URL, {
        headers: {
            Cookie: session.cookieHeader,
            [settings_1.CSRF_HEADER_NAME]: session.ajaxKey,
        },
        timeoutMs: settings_1.KEEPALIVE_REQUEST_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
    });
    return response.status === 200;
}
//# sourceMappingURL=auth.js.map