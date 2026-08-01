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
 */

import { ConfigurationError } from '../errors'
import {
  DEFAULT_AUTH_INTERVAL_MIN,
  DEFAULT_POLL_INTERVAL_SEC,
  MAX_AUTH_INTERVAL_MIN,
  MAX_DIAGNOSTICS_INTERVAL_SEC,
  MAX_POLL_INTERVAL_SEC,
  MIN_AUTH_INTERVAL_MIN,
  MIN_POLL_INTERVAL_SEC,
  PLATFORM_NAME,
} from '../settings'
import type {
  ConfigValidationResult,
  MyAlarmComPlatformConfig,
  ResolvedConfig,
} from '../types/config'

/** A six-digit authenticator code, which is *not* what this plugin needs. */
const TOTP_CODE_PATTERN = /^\d{6}$/

/** Shortest plausible `twoFactorAuthenticationId`; real ones are far longer. */
const MIN_MFA_COOKIE_LENGTH = 20

/** Shortest allowed diagnostics heartbeat when the feature is enabled. */
const MIN_DIAGNOSTICS_INTERVAL_SEC = 30

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConfigurationError(`"${field}" is required in the ${PLATFORM_NAME} platform config`)
  }
  return value.trim()
}

/**
 * Clamp a numeric setting into [floor, ceiling], recording a warning if adjusted.
 *
 * Silently correcting would leave the user believing their configured interval
 * is in effect; refusing to start over a too-eager poll interval would be worse.
 * Config.json edits that skip the UI still need the same bounds.
 */
function clampToRange(
  value: unknown,
  { field, fallback, floor, ceiling, unit, warnings }: {
    field: string
    fallback: number
    floor: number
    ceiling: number
    unit: string
    warnings: string[]
  },
): number {
  if (value === undefined || value === null) {
    return fallback
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    warnings.push(`"${field}" must be a number; using the default of ${fallback} ${unit}`)
    return fallback
  }

  if (value < floor) {
    warnings.push(
      `"${field}" was raised from ${value} to ${floor} ${unit}. Alarm.com may lock accounts that poll or re-authenticate more aggressively than this.`,
    )
    return floor
  }

  if (value > ceiling) {
    warnings.push(
      `"${field}" was lowered from ${value} to ${ceiling} ${unit}.`,
    )
    return ceiling
  }

  return value
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Parse the diagnostics heartbeat interval.
 *
 * `0` (or omitted) disables emission. Out-of-range positive values are clamped
 * (floor 30s, ceiling one day) with a warning rather than rejecting startup —
 * a mistyped interval must not take the child bridge down.
 */
function parseDiagnosticsInterval(value: unknown, warnings: string[]): number {
  if (value === undefined || value === null) {
    return 0
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigurationError('"diagnosticsInterval" must be a number of seconds')
  }

  if (value === 0) {
    return 0
  }

  if (value < 0) {
    throw new ConfigurationError('"diagnosticsInterval" cannot be negative')
  }

  if (value > MAX_DIAGNOSTICS_INTERVAL_SEC) {
    warnings.push(
      `"diagnosticsInterval" was lowered from ${value} to ${MAX_DIAGNOSTICS_INTERVAL_SEC} seconds (24h maximum).`,
    )
    return MAX_DIAGNOSTICS_INTERVAL_SEC
  }

  if (value < MIN_DIAGNOSTICS_INTERVAL_SEC) {
    warnings.push(
      `"diagnosticsInterval" was raised from ${value} to ${MIN_DIAGNOSTICS_INTERVAL_SEC} seconds.`,
    )
    return MIN_DIAGNOSTICS_INTERVAL_SEC
  }

  return value
}

function parseIgnoredIds(value: unknown, warnings: string[]): ReadonlySet<string> {
  if (value === undefined || value === null) {
    return new Set()
  }
  if (!Array.isArray(value)) {
    warnings.push('"ignoredDeviceIds" must be a list of device IDs; ignoring it')
    return new Set()
  }
  return new Set(
    value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
}

/**
 * Validate the two-factor cookie.
 *
 * The six-digit check exists because the mistake is genuinely easy to make and
 * otherwise produces a baffling `409 TwoFactorAuthenticationRequired` at
 * runtime rather than anything pointing at the config.
 */
function parseMfaCookie(value: unknown, warnings: string[]): string {
  if (value === undefined || value === null || value === '') {
    warnings.push(
      'No "twoFactorAuthenticationId" is configured. This is only workable on an Alarm.com account with two-factor authentication disabled.',
    )
    return ''
  }

  if (typeof value !== 'string') {
    throw new ConfigurationError('"twoFactorAuthenticationId" must be a string')
  }

  const cookie = value.trim()

  if (TOTP_CODE_PATTERN.test(cookie)) {
    throw new ConfigurationError(
      '"twoFactorAuthenticationId" looks like a six-digit authenticator code. It must instead be the value of the browser cookie of that name, copied from a signed-in Alarm.com session. See the plugin README for how to find it.',
    )
  }

  if (cookie.length < MIN_MFA_COOKIE_LENGTH) {
    warnings.push(
      '"twoFactorAuthenticationId" is shorter than expected and may be truncated; authentication will likely fail.',
    )
  }

  return cookie
}

/**
 * Validate and normalise the user's platform configuration.
 *
 * @throws {ConfigurationError} When a required value is missing or unusable.
 */
export function validateConfig(raw: MyAlarmComPlatformConfig): ConfigValidationResult {
  const warnings: string[] = []

  const config: ResolvedConfig = {
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : PLATFORM_NAME,
    username: requireNonEmptyString(raw.username, 'username'),
    password: requireNonEmptyString(raw.password, 'password'),
    twoFactorAuthenticationId: parseMfaCookie(raw.twoFactorAuthenticationId, warnings),
    pollIntervalSeconds: clampToRange(raw.pollIntervalSeconds, {
      field: 'pollIntervalSeconds',
      fallback: DEFAULT_POLL_INTERVAL_SEC,
      floor: MIN_POLL_INTERVAL_SEC,
      ceiling: MAX_POLL_INTERVAL_SEC,
      unit: 'seconds',
      warnings,
    }),
    authIntervalMinutes: clampToRange(raw.authIntervalMinutes, {
      field: 'authIntervalMinutes',
      fallback: DEFAULT_AUTH_INTERVAL_MIN,
      floor: MIN_AUTH_INTERVAL_MIN,
      ceiling: MAX_AUTH_INTERVAL_MIN,
      unit: 'minutes',
      warnings,
    }),
    useEventStream: parseBoolean(raw.useEventStream, true),
    ignoredDeviceIds: parseIgnoredIds(raw.ignoredDeviceIds, warnings),
    includeUnmonitoredSensors: parseBoolean(raw.includeUnmonitoredSensors, false),
    debug: parseBoolean(raw.debug, false),
    diagnosticsInterval: parseDiagnosticsInterval(raw.diagnosticsInterval, warnings),
  }

  return { config, warnings }
}
