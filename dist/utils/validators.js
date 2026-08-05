"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Configuration validation.
 *
 * Alarm.com punishes misconfiguration harshly: too-frequent polling or repeated
 * logins can get an account locked, which takes the alarm panel's app access
 * down with it. Values are therefore clamped to safe floors rather than trusted,
 * and the user is told when a clamp was applied.
 *
 * Nothing here throws. Homebridge does not guard a platform constructor, so a
 * thrown error escapes `loadPlatforms()` and terminates the whole bridge —
 * every other plugin and every other accessory in the house — over one typo in
 * this plugin's block. Fatal problems are returned as `errors` instead, and the
 * platform reports them and stays inert.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateConfig = validateConfig;
const settings_1 = require("../settings");
/** A six-digit authenticator code, which is *not* what this plugin needs. */
const TOTP_CODE_PATTERN = /^\d{6}$/;
/** Shortest plausible `twoFactorAuthenticationId`; real ones are far longer. */
const MIN_MFA_COOKIE_LENGTH = 20;
/**
 * Longest any configured string may be.
 *
 * Not a security boundary — anyone who can edit `config.json` already holds the
 * credentials. It catches the paste error where a whole `document.cookie` or a
 * page of HTML lands in a field, and turns a baffling upstream rejection into a
 * message that names the field.
 */
const MAX_CONFIG_STRING_LENGTH = 4_096;
/**
 * Characters RFC 6265 permits in a cookie value.
 *
 * The two-factor value is interpolated straight into a `Cookie` header, so a
 * pasted `name=value; other=value` string would inject a second cookie pair
 * rather than failing with something a user could act on.
 */
const COOKIE_VALUE_PATTERN = /^[\w!#-+\--:<-[\]-~]*$/;
function readRequiredString(value, field, report) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        report.errors.push(`"${field}" is required in the ${settings_1.PLATFORM_NAME} platform config`);
        return '';
    }
    const trimmed = value.trim();
    if (trimmed.length > MAX_CONFIG_STRING_LENGTH) {
        report.errors.push(`"${field}" is longer than ${MAX_CONFIG_STRING_LENGTH} characters; check for a paste error`);
        return '';
    }
    return trimmed;
}
/**
 * Clamp a numeric setting into [floor, ceiling], recording a warning if adjusted.
 *
 * Silently correcting would leave the user believing their configured interval
 * is in effect; refusing to start over a too-eager poll interval would be worse.
 * Config.json edits that skip the UI still need the same bounds.
 *
 * Rounded to an integer to match `config.schema.json`, which declares these
 * fields as integers and so never produced a fractional value through the UI.
 */
/** Why the polling and re-authentication floors exist. */
const ACCOUNT_LOCKOUT_RATIONALE = 'Alarm.com may lock accounts that poll or re-authenticate more aggressively than this';
function clampToRange(value, { field, fallback, floor, ceiling, unit, warnings, floorRationale = ACCOUNT_LOCKOUT_RATIONALE }) {
    if (value === undefined || value === null) {
        return fallback;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        warnings.push(`"${field}" must be a number; using the default of ${fallback} ${unit}`);
        return fallback;
    }
    const rounded = Math.round(value);
    if (rounded < floor) {
        warnings.push(`"${field}" was raised from ${value} to ${floor} ${unit}; ${floorRationale}.`);
        return floor;
    }
    if (rounded > ceiling) {
        warnings.push(`"${field}" was lowered from ${value} to ${ceiling} ${unit}.`);
        return ceiling;
    }
    return rounded;
}
function parseBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
/**
 * Why a value below the diagnostics floor is raised.
 *
 * The shared message is about Alarm.com locking accounts that poll too hard,
 * which has nothing to do with a log heartbeat — diagnostics generate no
 * Alarm.com traffic at all. Telling a user that a logging interval risks their
 * alarm account is worse than saying nothing.
 */
const DIAGNOSTICS_FLOOR_RATIONALE = 'a denser heartbeat is more than 2,880 log lines a day';
/**
 * Parse the diagnostics heartbeat interval.
 *
 * `0` (or omitted) disables emission. Everything else is clamped (floor 30s,
 * ceiling one day) with a warning: a mistyped optional diagnostics interval is
 * not a reason to leave a security integration switched off.
 */
function parseDiagnosticsInterval(value, warnings) {
    if (value === undefined || value === null || value === 0) {
        return 0;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        warnings.push('"diagnosticsInterval" must be a number of seconds; diagnostics are disabled');
        return 0;
    }
    if (value < 0) {
        warnings.push('"diagnosticsInterval" cannot be negative; diagnostics are disabled');
        return 0;
    }
    return clampToRange(value, {
        field: 'diagnosticsInterval',
        fallback: 0,
        floor: settings_1.MIN_DIAGNOSTICS_INTERVAL_SEC,
        ceiling: settings_1.MAX_DIAGNOSTICS_INTERVAL_SEC,
        unit: 'seconds',
        warnings,
        floorRationale: DIAGNOSTICS_FLOOR_RATIONALE,
    });
}
function parseIgnoredIds(value, warnings) {
    if (value === undefined || value === null) {
        return new Set();
    }
    if (!Array.isArray(value)) {
        warnings.push('"ignoredDeviceIds" must be a list of device IDs; ignoring it');
        return new Set();
    }
    const usable = value
        .filter((entry) => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    // Counted against the usable list, not the deduplicated set. Comparing with
    // the set meant listing the same ID twice was reported as an unusable entry,
    // which sent the user looking for a typo that was not there.
    const rejected = value.length - usable.length;
    if (rejected > 0) {
        warnings.push(`"ignoredDeviceIds" contained ${rejected} entr${rejected === 1 ? 'y' : 'ies'} that ${rejected === 1 ? 'was' : 'were'} not a usable device ID; skipped`);
    }
    return new Set(usable);
}
/**
 * Validate the two-factor cookie.
 *
 * The six-digit check exists because the mistake is genuinely easy to make and
 * otherwise produces a baffling `409 TwoFactorAuthenticationRequired` at
 * runtime rather than anything pointing at the config.
 */
function parseMfaCookie(value, report) {
    if (value === undefined || value === null || value === '') {
        report.warnings.push('No "twoFactorAuthenticationId" is configured. This is only workable on an Alarm.com account with two-factor authentication disabled.');
        return '';
    }
    if (typeof value !== 'string') {
        report.errors.push('"twoFactorAuthenticationId" must be a string');
        return '';
    }
    const cookie = value.trim();
    if (cookie.length > MAX_CONFIG_STRING_LENGTH) {
        report.errors.push(`"twoFactorAuthenticationId" is longer than ${MAX_CONFIG_STRING_LENGTH} characters; check for a paste error`);
        return '';
    }
    if (TOTP_CODE_PATTERN.test(cookie)) {
        report.errors.push('"twoFactorAuthenticationId" looks like a six-digit authenticator code. It must instead be the value of the browser cookie of that name, copied from a signed-in Alarm.com session. See docs/AUTH.md for how to find it.');
        return '';
    }
    if (!COOKIE_VALUE_PATTERN.test(cookie)) {
        report.errors.push('"twoFactorAuthenticationId" contains characters that are not valid in a cookie value. Copy only the value of that one cookie, not the whole cookie header.');
        return '';
    }
    if (cookie.length < MIN_MFA_COOKIE_LENGTH) {
        report.warnings.push('"twoFactorAuthenticationId" is shorter than expected and may be truncated; authentication will likely fail.');
    }
    return cookie;
}
/**
 * Validate and normalise the user's platform configuration.
 *
 * @returns `config` is `null` when a fatal problem was found; `errors` then
 *   explains what the user must fix.
 */
function validateConfig(raw) {
    const report = { errors: [], warnings: [] };
    const { warnings } = report;
    const config = {
        username: readRequiredString(raw.username, 'username', report),
        password: readRequiredString(raw.password, 'password', report),
        twoFactorAuthenticationId: parseMfaCookie(raw.twoFactorAuthenticationId, report),
        pollIntervalSeconds: clampToRange(raw.pollIntervalSeconds, {
            field: 'pollIntervalSeconds',
            fallback: settings_1.DEFAULT_POLL_INTERVAL_SEC,
            floor: settings_1.MIN_POLL_INTERVAL_SEC,
            ceiling: settings_1.MAX_POLL_INTERVAL_SEC,
            unit: 'seconds',
            warnings,
        }),
        authIntervalMinutes: clampToRange(raw.authIntervalMinutes, {
            field: 'authIntervalMinutes',
            fallback: settings_1.DEFAULT_AUTH_INTERVAL_MIN,
            floor: settings_1.MIN_AUTH_INTERVAL_MIN,
            ceiling: settings_1.MAX_AUTH_INTERVAL_MIN,
            unit: 'minutes',
            warnings,
        }),
        useEventStream: parseBoolean(raw.useEventStream, true),
        ignoredDeviceIds: parseIgnoredIds(raw.ignoredDeviceIds, warnings),
        includeUnmonitoredSensors: parseBoolean(raw.includeUnmonitoredSensors, false),
        debug: parseBoolean(raw.debug, false),
        diagnosticsInterval: parseDiagnosticsInterval(raw.diagnosticsInterval, warnings),
    };
    return {
        config: report.errors.length > 0 ? null : config,
        warnings: report.warnings,
        errors: report.errors,
    };
}
//# sourceMappingURL=validators.js.map