/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Platform configuration, as written by the user and as resolved.
 */
/** The platform block exactly as it appears in the Homebridge config file. */
export interface MyAlarmComPlatformConfig {
    platform: string;
    name?: string;
    /** Alarm.com login email. */
    username?: unknown;
    /** Alarm.com password. */
    password?: unknown;
    /**
     * The `twoFactorAuthenticationId` cookie copied from a signed-in browser.
     *
     * Required on any account with two-factor enabled. This is a cookie value,
     * not a six-digit code from an authenticator app.
     */
    twoFactorAuthenticationId?: unknown;
    /** Seconds between full state refreshes. */
    pollIntervalSeconds?: unknown;
    /** Minutes a session is reused before re-authenticating. */
    authIntervalMinutes?: unknown;
    /** Subscribe to the push event stream instead of relying on polling alone. */
    useEventStream?: unknown;
    /** Alarm.com device IDs to leave out of HomeKit entirely. */
    ignoredDeviceIds?: unknown;
    /** Expose sensors whose monitoring Alarm.com reports as disabled. */
    includeUnmonitoredSensors?: unknown;
    /** Emit verbose diagnostics. */
    debug?: unknown;
}
/** Configuration after validation, with every value present and in range. */
export interface ResolvedConfig {
    name: string;
    username: string;
    password: string;
    twoFactorAuthenticationId: string;
    pollIntervalSeconds: number;
    authIntervalMinutes: number;
    useEventStream: boolean;
    ignoredDeviceIds: ReadonlySet<string>;
    includeUnmonitoredSensors: boolean;
    debug: boolean;
}
/** Outcome of validating user configuration. */
export interface ConfigValidationResult {
    config: ResolvedConfig;
    /** Non-fatal problems worth telling the user about. */
    warnings: string[];
}
//# sourceMappingURL=config.d.ts.map