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
  platform: string

  /**
   * Instance name.
   *
   * Read by Homebridge itself, which uses it as the log prefix. The plugin
   * never reads it, so it is declared here only to document that the field is
   * expected rather than ignored.
   */
  name?: unknown

  /** Alarm.com username, usually an email address. */
  username?: unknown
  /** Alarm.com password. */
  password?: unknown

  /**
   * The `twoFactorAuthenticationId` cookie copied from a signed-in browser.
   *
   * Required on any account with two-factor enabled. This is a cookie value,
   * not a six-digit code from an authenticator app.
   */
  twoFactorAuthenticationId?: unknown

  /** Seconds between full state refreshes. */
  pollIntervalSeconds?: unknown
  /** Minutes a session is reused before re-authenticating. */
  authIntervalMinutes?: unknown

  /** Subscribe to the push event stream instead of relying on polling alone. */
  useEventStream?: unknown

  /** Alarm.com device IDs to leave out of HomeKit entirely. */
  ignoredDeviceIds?: unknown

  /** Expose sensors whose monitoring Alarm.com reports as disabled. */
  includeUnmonitoredSensors?: unknown

  /** Emit verbose diagnostics. */
  debug?: unknown

  /**
   * Seconds between health/activity heartbeats in the Homebridge log.
   *
   * `0` disables emission (default). Values `1`–`29` are raised to `30`;
   * values above one day (`86400`) are lowered to that ceiling.
   */
  diagnosticsInterval?: unknown
}

/** Configuration after validation, with every value present and in range. */
export interface ResolvedConfig {
  username: string
  password: string
  twoFactorAuthenticationId: string
  pollIntervalSeconds: number
  authIntervalMinutes: number
  useEventStream: boolean
  ignoredDeviceIds: ReadonlySet<string>
  includeUnmonitoredSensors: boolean
  debug: boolean
  /** Seconds between diagnostics heartbeats; `0` means emission is off. */
  diagnosticsInterval: number
}

/** Outcome of validating user configuration. */
export interface ConfigValidationResult {
  /** The usable configuration, or `null` when {@link errors} is non-empty. */
  config: ResolvedConfig | null
  /** Non-fatal problems worth telling the user about. */
  warnings: string[]
  /** Problems the user must fix before the platform can run at all. */
  errors: string[]
}
