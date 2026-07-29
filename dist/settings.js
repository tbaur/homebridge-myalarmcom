"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Plugin-wide constants and Alarm.com endpoints.
 *
 * Alarm.com publishes no consumer API and no documentation. Every value here
 * was confirmed empirically against a live account (see `scripts/probe.mjs`),
 * and each one that looks arbitrary has a comment explaining why it is what it
 * is. Treat this file as the record of what the service actually does, because
 * nothing external will tell you when it changes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WEBSOCKET_REFRESH_JITTER_MS = exports.WEBSOCKET_REFRESH_INTERVAL_MS = exports.WEBSOCKET_MAX_FAILURES = exports.WEBSOCKET_RECONNECT_MAX_MS = exports.WEBSOCKET_RECONNECT_BASE_MS = exports.WEBSOCKET_HANDSHAKE_TIMEOUT_MS = exports.WEBSOCKET_HOST_SUFFIX = exports.DEFAULT_WEBSOCKET_ENDPOINT = exports.REDISCOVERY_INTERVAL_MS = exports.MAX_RETRY_BACKOFF_MS = exports.MAX_API_RETRY_ATTEMPTS = exports.KEEPALIVE_INTERVAL_MS = exports.DEFAULT_AUTH_INTERVAL_MIN = exports.MIN_AUTH_INTERVAL_MIN = exports.DEFAULT_POLL_INTERVAL_SEC = exports.MIN_POLL_INTERVAL_SEC = exports.DEFAULT_REQUEST_TIMEOUT_MS = exports.MAX_IDS_PER_REQUEST = exports.CSRF_HEADER_NAME = exports.CSRF_COOKIE_NAME = exports.MFA_COOKIE_NAME = exports.EVENT_FIELD_SENTINEL = exports.PASSWORD_FIELD = exports.USERNAME_FIELD = exports.LOGIN_FORM_FIELDS = exports.JSON_API_ACCEPT = exports.HOME_REFERER = exports.WEBSOCKET_TOKEN_URL = exports.SENSORS_URL = exports.PARTITIONS_URL = exports.SYSTEM_URL = exports.KEEPALIVE_URL = exports.IDENTITIES_URL = exports.LOGIN_POST_URL = exports.LOGIN_PAGE_URL = exports.BASE_URL = exports.MANUFACTURER = exports.UUID_PREFIX = exports.PLATFORM_NAME = exports.PLUGIN_NAME = void 0;
/** Name used to register the plugin with Homebridge (must match package.json name). */
exports.PLUGIN_NAME = 'homebridge-myalarmcom';
/** Platform identifier referenced in the user's Homebridge config. */
exports.PLATFORM_NAME = 'MyAlarmCom';
/** Prefix used when generating stable HAP accessory UUIDs. */
exports.UUID_PREFIX = 'myalarmcom-';
/** Reported as the HomeKit accessory manufacturer. */
exports.MANUFACTURER = 'Alarm.com';
// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------
/** Root of the Alarm.com web application. */
exports.BASE_URL = 'https://www.alarm.com';
/** Page whose HTML carries the hidden WebForms fields needed to post a login. */
exports.LOGIN_PAGE_URL = `${exports.BASE_URL}/login`;
/** WebForms postback target that authenticates the credentials. */
exports.LOGIN_POST_URL = `${exports.BASE_URL}/web/Default.aspx`;
/** Returns the signed-in user, their systems, and account preferences. */
exports.IDENTITIES_URL = `${exports.BASE_URL}/web/api/identities`;
/**
 * Cheap session touch. Returns `{ status: <number> }`.
 *
 * Confirmed present and returning 200 on a live account. This matters more than
 * it looks: re-authenticating is the operation Alarm.com polices for abuse, so
 * refreshing an existing session is materially safer than establishing a new
 * one. The community plugin has no equivalent and logs in from scratch every
 * ten minutes.
 */
exports.KEEPALIVE_URL = `${exports.BASE_URL}/web/KeepAlive.aspx`;
/** System overview. Append the system ID; its `relationships` list device IDs. */
exports.SYSTEM_URL = `${exports.BASE_URL}/web/api/systems/systems/`;
/** Partition (security panel) collection. Append an ID, or query with `ids[]`. */
exports.PARTITIONS_URL = `${exports.BASE_URL}/web/api/devices/partitions`;
/** Sensor collection. Append an ID, or query with `ids[]`. */
exports.SENSORS_URL = `${exports.BASE_URL}/web/api/devices/sensors`;
/** Issues a short-lived token plus the endpoint for the event stream. */
exports.WEBSOCKET_TOKEN_URL = `${exports.BASE_URL}/web/api/websockets/token`;
/**
 * Sent as `Referer` on every JSON:API request.
 *
 * Alarm.com's API is the web app's own backend and expects requests to look
 * like they came from it.
 */
exports.HOME_REFERER = `${exports.BASE_URL}/web/system/home`;
/** JSON:API content type Alarm.com negotiates on. */
exports.JSON_API_ACCEPT = 'application/vnd.api+json';
// ---------------------------------------------------------------------------
// Login form
// ---------------------------------------------------------------------------
/**
 * Hidden ASP.NET WebForms inputs scraped from the login page and echoed back on
 * the postback. If Alarm.com reworks its login page, these break first.
 */
exports.LOGIN_FORM_FIELDS = [
    '__VIEWSTATE',
    '__VIEWSTATEGENERATOR',
    '__EVENTVALIDATION',
    '__PREVIOUSPAGE',
];
/** Form field carrying the username on the login postback. */
exports.USERNAME_FIELD = 'ctl00$ContentPlaceHolder1$loginform$txtUserName';
/** Form field carrying the password on the login postback. */
exports.PASSWORD_FIELD = 'txtPassword';
/**
 * The three `__EVENT*` fields are posted as the literal string `"null"`.
 *
 * This is not a typo. It is what the long-running community client sends and
 * what the endpoint accepts today. Against an undocumented black box, matching
 * known-working bytes beats sending what ought to be correct.
 */
exports.EVENT_FIELD_SENTINEL = 'null';
/**
 * Cookie carrying the two-factor trust token.
 *
 * The token is a bearer credential scoped to one Alarm.com *user*, not to a
 * machine or browser, so it can be replayed by any client. That is why this
 * approach works at all, and also why it is a liability: it is a durable 2FA
 * bypass sitting in plaintext Homebridge config.
 */
exports.MFA_COOKIE_NAME = 'twoFactorAuthenticationId';
/** Cookie holding the anti-CSRF value echoed back on every API request. */
exports.CSRF_COOKIE_NAME = 'afg';
/** Header carrying the anti-CSRF value from {@link CSRF_COOKIE_NAME}. */
exports.CSRF_HEADER_NAME = 'ajaxrequestuniquekey';
// ---------------------------------------------------------------------------
// Request tuning
// ---------------------------------------------------------------------------
/**
 * Maximum `ids[]` query parameters per batch read.
 *
 * Alarm.com answers a longer query string with a 404 rather than a useful
 * error, so oversized batches fail as "no such endpoint".
 */
exports.MAX_IDS_PER_REQUEST = 50;
/** Hard ceiling on any single request. Never wait on Alarm.com indefinitely. */
exports.DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/**
 * Floor on the polling interval, in seconds.
 *
 * The community plugin's own documentation warns that polling faster than this
 * risks Alarm.com disabling the account. A locked panel is a far worse outcome
 * than slightly stale state, so this is enforced rather than merely defaulted.
 */
exports.MIN_POLL_INTERVAL_SEC = 60;
/** Default polling interval when the user does not choose one. */
exports.DEFAULT_POLL_INTERVAL_SEC = 60;
/**
 * Floor on how often a full re-authentication may occur, in minutes.
 *
 * Same rationale as {@link MIN_POLL_INTERVAL_SEC}: login is the request most
 * likely to trip abuse detection.
 */
exports.MIN_AUTH_INTERVAL_MIN = 10;
/** Default session lifetime before re-authenticating, in minutes. */
exports.DEFAULT_AUTH_INTERVAL_MIN = 10;
/** How often to touch {@link KEEPALIVE_URL} to hold the session open. */
exports.KEEPALIVE_INTERVAL_MS = 4 * 60_000;
/** Maximum attempts for a single API request before surfacing the failure. */
exports.MAX_API_RETRY_ATTEMPTS = 3;
/** Cap on how long a retry may back off. */
exports.MAX_RETRY_BACKOFF_MS = 60_000;
/**
 * How often to re-enumerate the account's devices.
 *
 * Polling refreshes known devices only, so this is what notices a sensor being
 * added or removed at the panel. Hourly keeps a rare event reasonably fresh
 * without spending requests on a list that almost never changes.
 */
exports.REDISCOVERY_INTERVAL_MS = 60 * 60 * 1_000;
// ---------------------------------------------------------------------------
// Event stream
// ---------------------------------------------------------------------------
/** Fallback event-stream endpoint when the token response omits one. */
exports.DEFAULT_WEBSOCKET_ENDPOINT = 'wss://webskt.alarm.com:8443';
/**
 * The only domain the event-stream token may be sent to.
 *
 * The endpoint is read from a server response and the token is appended to it,
 * so without this the response decides where a live credential goes.
 */
exports.WEBSOCKET_HOST_SUFFIX = '.alarm.com';
/** Upper bound on waiting for the first WebSocket open/close during connect. */
exports.WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 15_000;
/** Delay before the first reconnect attempt after the stream drops. */
exports.WEBSOCKET_RECONNECT_BASE_MS = 5_000;
/** Upper bound on the reconnect backoff. */
exports.WEBSOCKET_RECONNECT_MAX_MS = 5 * 60_000;
/**
 * Consecutive stream failures tolerated before falling back to polling.
 *
 * The event stream is the primary state source; polling is the safety net.
 */
exports.WEBSOCKET_MAX_FAILURES = 5;
/**
 * Proactively re-establish the event stream on this interval.
 *
 * Alarm.com's stream token dies around five minutes; refreshing at five minutes
 * (plus jitter) races the server close and loses — the drop path then logs a
 * noisy info-level "reconnected". Refresh before expiry so the routine path
 * (`refreshed` at debug) wins instead.
 */
exports.WEBSOCKET_REFRESH_INTERVAL_MS = 4 * 60_000;
/**
 * Random spread added to the stream refresh so reconnects do not synchronize.
 * Kept well below the gap between this interval and the ~5-minute token lifetime.
 */
exports.WEBSOCKET_REFRESH_JITTER_MS = 15_000;
//# sourceMappingURL=settings.js.map