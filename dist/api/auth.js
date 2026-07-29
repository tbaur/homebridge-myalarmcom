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
 * Pull the hidden WebForms inputs out of the login page HTML.
 *
 * Reports what was missing rather than throwing on the first absent field,
 * because "Alarm.com changed its login form" is a far more actionable diagnosis
 * than a generic failure further downstream.
 */
function scrapeHiddenFields(html) {
    const found = {};
    const missing = [];
    for (const name of settings_1.LOGIN_FORM_FIELDS) {
        const match = new RegExp(`name="${name}"[\\s\\S]*?value="([^"]*)"`).exec(html);
        if (match) {
            found[name] = match[1];
        }
        else {
            missing.push(name);
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
        IsFromNewSite: '1',
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
 * @throws {LoginFormError} The login page could not be parsed.
 * @throws {TwoFactorRequiredError} Alarm.com demanded two-factor verification.
 * @throws {AuthenticationError} The credentials were rejected.
 */
async function authenticate(credentials, log) {
    const pageResponse = await (0, http_1.httpRequest)(settings_1.LOGIN_PAGE_URL);
    const html = await pageResponse.text();
    const { found: hiddenFields, missing } = scrapeHiddenFields(html);
    if (missing.length > 0) {
        throw new errors_1.LoginFormError(`Could not find the login form fields ${missing.join(', ')}. Alarm.com may have changed its sign-in page; this plugin needs an update.`);
    }
    const headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
    };
    // Only send the trust cookie when there is one. Sending the literal string
    // "undefined" is worse than sending nothing.
    if (credentials.twoFactorAuthenticationId) {
        headers.Cookie = `${settings_1.MFA_COOKIE_NAME}=${credentials.twoFactorAuthenticationId}`;
    }
    const loginResponse = await (0, http_1.httpRequest)(settings_1.LOGIN_POST_URL, {
        method: 'POST',
        headers,
        body: buildLoginBody(credentials.username, credentials.password, hiddenFields),
    });
    const jar = new cookie_jar_1.CookieJar();
    jar.absorb(loginResponse);
    log.debug(`login responded ${loginResponse.status} with cookies [${jar.names.join(', ')}], sent trust token ${(0, sanitizers_1.previewSecret)(credentials.twoFactorAuthenticationId)}`);
    if (loginResponse.status === 409) {
        throw new errors_1.TwoFactorRequiredError();
    }
    // A WebForms login reports failure by re-rendering the form with a 200 rather
    // than redirecting, so success is the redirect and 200 is the error case.
    if (loginResponse.status === 200) {
        throw new errors_1.AuthenticationError('Alarm.com rejected the username or password. Note that repeated failures will lock the account.');
    }
    const ajaxKey = jar.get(settings_1.CSRF_COOKIE_NAME);
    if (!ajaxKey) {
        throw new errors_1.AuthenticationError(`Signed in but Alarm.com did not return the "${settings_1.CSRF_COOKIE_NAME}" cookie needed to call its API.`);
    }
    // If Alarm.com hands back a *different* trust token than the one supplied,
    // the supplied one was not honoured. Surfacing this early turns an eventual
    // mystery 409 into a clear warning.
    const returnedTrustToken = jar.get(settings_1.MFA_COOKIE_NAME);
    if (credentials.twoFactorAuthenticationId
        && returnedTrustToken
        && returnedTrustToken !== credentials.twoFactorAuthenticationId) {
        log.warn('Alarm.com issued a new two-factor trust token, which means the configured one was not accepted. Re-copy the cookie from a signed-in browser if requests start failing.');
    }
    return {
        cookieHeader: jar.toHeader(),
        ajaxKey,
        createdAt: new Date(),
    };
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
async function keepAlive(session) {
    const response = await (0, http_1.httpRequest)(settings_1.KEEPALIVE_URL, {
        headers: {
            Cookie: session.cookieHeader,
            ajaxrequestuniquekey: session.ajaxKey,
        },
    });
    return response.status === 200;
}
//# sourceMappingURL=auth.js.map