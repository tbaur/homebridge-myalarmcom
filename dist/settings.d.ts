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
/** Name used to register the plugin with Homebridge (must match package.json name). */
export declare const PLUGIN_NAME = "homebridge-myalarmcom";
/** Platform identifier referenced in the user's Homebridge config. */
export declare const PLATFORM_NAME = "MyAlarmCom";
/** Prefix used when generating stable HAP accessory UUIDs. */
export declare const UUID_PREFIX = "myalarmcom-";
/** Reported as the HomeKit accessory manufacturer. */
export declare const MANUFACTURER = "Alarm.com";
/** Root of the Alarm.com web application. */
export declare const BASE_URL = "https://www.alarm.com";
/** Page whose HTML carries the hidden WebForms fields needed to post a login. */
export declare const LOGIN_PAGE_URL = "https://www.alarm.com/login";
/** WebForms postback target that authenticates the credentials. */
export declare const LOGIN_POST_URL = "https://www.alarm.com/web/Default.aspx";
/** Returns the signed-in user, their systems, and account preferences. */
export declare const IDENTITIES_URL = "https://www.alarm.com/web/api/identities";
/**
 * Cheap session touch. Returns `{ status: <number> }`.
 *
 * Confirmed present and returning 200 on a live account. This matters more than
 * it looks: re-authenticating is the operation Alarm.com polices for abuse, so
 * refreshing an existing session is materially safer than establishing a new
 * one. The community plugin has no equivalent and logs in from scratch every
 * ten minutes.
 */
export declare const KEEPALIVE_URL = "https://www.alarm.com/web/KeepAlive.aspx";
/** System overview. Append the system ID; its `relationships` list device IDs. */
export declare const SYSTEM_URL = "https://www.alarm.com/web/api/systems/systems/";
/** Partition (security panel) collection. Append an ID, or query with `ids[]`. */
export declare const PARTITIONS_URL = "https://www.alarm.com/web/api/devices/partitions";
/** Sensor collection. Append an ID, or query with `ids[]`. */
export declare const SENSORS_URL = "https://www.alarm.com/web/api/devices/sensors";
/** Issues a short-lived token plus the endpoint for the event stream. */
export declare const WEBSOCKET_TOKEN_URL = "https://www.alarm.com/web/api/websockets/token";
/**
 * Sent as `Referer` on every JSON:API request.
 *
 * Alarm.com's API is the web app's own backend and expects requests to look
 * like they came from it.
 */
export declare const HOME_REFERER = "https://www.alarm.com/web/system/home";
/** JSON:API content type Alarm.com negotiates on. */
export declare const JSON_API_ACCEPT = "application/vnd.api+json";
/**
 * Hidden ASP.NET WebForms inputs scraped from the login page and echoed back on
 * the postback. If Alarm.com reworks its login page, these break first.
 */
export declare const LOGIN_FORM_FIELDS: readonly ["__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION", "__PREVIOUSPAGE"];
/** Form field carrying the username on the login postback. */
export declare const USERNAME_FIELD = "ctl00$ContentPlaceHolder1$loginform$txtUserName";
/** Form field carrying the password on the login postback. */
export declare const PASSWORD_FIELD = "txtPassword";
/**
 * The three `__EVENT*` fields are posted as the literal string `"null"`.
 *
 * This is not a typo. It is what the long-running community client sends and
 * what the endpoint accepts today. Against an undocumented black box, matching
 * known-working bytes beats sending what ought to be correct.
 */
export declare const EVENT_FIELD_SENTINEL = "null";
/**
 * Cookie carrying the two-factor trust token.
 *
 * The token is a bearer credential scoped to one Alarm.com *user*, not to a
 * machine or browser, so it can be replayed by any client. That is why this
 * approach works at all, and also why it is a liability: it is a durable 2FA
 * bypass sitting in plaintext Homebridge config.
 */
export declare const MFA_COOKIE_NAME = "twoFactorAuthenticationId";
/** Cookie holding the anti-CSRF value echoed back on every API request. */
export declare const CSRF_COOKIE_NAME = "afg";
/** Header carrying the anti-CSRF value from {@link CSRF_COOKIE_NAME}. */
export declare const CSRF_HEADER_NAME = "ajaxrequestuniquekey";
/**
 * Maximum `ids[]` query parameters per batch read.
 *
 * Alarm.com answers a longer query string with a 404 rather than a useful
 * error, so oversized batches fail as "no such endpoint".
 */
export declare const MAX_IDS_PER_REQUEST = 50;
/** Hard ceiling on any single request. Never wait on Alarm.com indefinitely. */
export declare const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
/**
 * Floor on the polling interval, in seconds.
 *
 * The community plugin's own documentation warns that polling faster than this
 * risks Alarm.com disabling the account. A locked panel is a far worse outcome
 * than slightly stale state, so this is enforced rather than merely defaulted.
 */
export declare const MIN_POLL_INTERVAL_SEC = 60;
/** Default polling interval when the user does not choose one. */
export declare const DEFAULT_POLL_INTERVAL_SEC = 60;
/** Cap on the polling interval, in seconds (one day). */
export declare const MAX_POLL_INTERVAL_SEC = 86400;
/**
 * Floor on how often a full re-authentication may occur, in minutes.
 *
 * Same rationale as {@link MIN_POLL_INTERVAL_SEC}: login is the request most
 * likely to trip abuse detection.
 */
export declare const MIN_AUTH_INTERVAL_MIN = 10;
/** Default session lifetime before re-authenticating, in minutes. */
export declare const DEFAULT_AUTH_INTERVAL_MIN = 10;
/** Cap on the re-authentication interval, in minutes (one day). */
export declare const MAX_AUTH_INTERVAL_MIN = 1440;
/**
 * Cap on the diagnostics heartbeat interval, in seconds (one day).
 *
 * Heartbeats denser than this are fine; rarer ones are clamped down so a typo
 * cannot silently disable useful logging for weeks.
 */
export declare const MAX_DIAGNOSTICS_INTERVAL_SEC = 86400;
/** How often to touch {@link KEEPALIVE_URL} to hold the session open. */
export declare const KEEPALIVE_INTERVAL_MS: number;
/**
 * Base delay before retrying a failed initial device discovery.
 *
 * Startup cannot reach Ready without a successful discovery. Transient failures
 * must retry with backoff rather than leaving the platform idle forever.
 */
export declare const INITIAL_DISCOVERY_RETRY_BASE_MS = 5000;
/** Cap on the delay between initial discovery retries. */
export declare const INITIAL_DISCOVERY_RETRY_MAX_MS: number;
/** Maximum attempts for a single API request before surfacing the failure. */
export declare const MAX_API_RETRY_ATTEMPTS = 3;
/** Cap on how long a retry may back off. */
export declare const MAX_RETRY_BACKOFF_MS = 60000;
/**
 * How often to re-enumerate the account's devices.
 *
 * Polling refreshes known devices only, so this is what notices a sensor being
 * added or removed at the panel. Hourly keeps a rare event reasonably fresh
 * without spending requests on a list that almost never changes.
 */
export declare const REDISCOVERY_INTERVAL_MS: number;
/** Fallback event-stream endpoint when the token response omits one. */
export declare const DEFAULT_WEBSOCKET_ENDPOINT = "wss://webskt.alarm.com:8443";
/**
 * The only domain the event-stream token may be sent to.
 *
 * The endpoint is read from a server response and the token is appended to it,
 * so without this the response decides where a live credential goes.
 */
export declare const WEBSOCKET_HOST_SUFFIX = ".alarm.com";
/** Upper bound on waiting for the first WebSocket open/close during connect. */
export declare const WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 15000;
/** Delay before the first reconnect attempt after the stream drops. */
export declare const WEBSOCKET_RECONNECT_BASE_MS = 5000;
/** Upper bound on the reconnect backoff. */
export declare const WEBSOCKET_RECONNECT_MAX_MS: number;
/**
 * Consecutive stream failures tolerated before falling back to polling.
 *
 * The event stream is the primary state source; polling is the safety net.
 * After this many failures the stream schedules a longer recovery attempt
 * rather than giving up for the process lifetime.
 */
export declare const WEBSOCKET_MAX_FAILURES = 5;
/**
 * How long to wait after giving up before trying the event stream again.
 *
 * Polling continues in the meantime. Without this, a transient outage would
 * leave push updates dead until Homebridge restarted.
 */
export declare const WEBSOCKET_RECOVERY_INTERVAL_MS: number;
/**
 * Proactively re-establish the event stream on this interval.
 *
 * Alarm.com's stream token dies around five minutes; refreshing at five minutes
 * races the server close and loses — the drop path then logs a noisy info-level
 * "reconnected". Refresh well before expiry so the routine path (`refreshed` at
 * debug) wins instead. Jitter *subtracts* from this value (see
 * {@link WEBSOCKET_REFRESH_JITTER_MS}).
 */
export declare const WEBSOCKET_REFRESH_INTERVAL_MS: number;
/**
 * Random amount subtracted from {@link WEBSOCKET_REFRESH_INTERVAL_MS}.
 *
 * Subtractive (not additive) so refresh always lands earlier than the base,
 * preserving margin before the ~5-minute token lifetime. Also desynchronizes
 * multiple Homebridge instances.
 */
export declare const WEBSOCKET_REFRESH_JITTER_MS = 30000;
//# sourceMappingURL=settings.d.ts.map