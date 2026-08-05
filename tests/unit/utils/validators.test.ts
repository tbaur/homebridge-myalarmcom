/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Misconfiguration here is expensive: Alarm.com can lock an account that polls
 * or re-authenticates too aggressively, which takes the panel's own app access
 * down with it. The clamps are therefore asserted as behaviour, not defaults.
 */

import type { MyAlarmComPlatformConfig, ResolvedConfig } from '../../../src/types/config'
import { validateConfig } from '../../../src/utils/validators'

const MFA_COOKIE = 'a'.repeat(64)

function configWith(overrides: Partial<MyAlarmComPlatformConfig> = {}): MyAlarmComPlatformConfig {
  return {
    platform: 'MyAlarmCom',
    username: 'user@example.com',
    password: 'correct-horse-battery',
    twoFactorAuthenticationId: MFA_COOKIE,
    ...overrides,
  }
}

/** Validate a config expected to be usable, failing loudly if it is not. */
function resolve(overrides: Partial<MyAlarmComPlatformConfig> = {}): {
  config: ResolvedConfig
  warnings: string[]
} {
  const { config, warnings, errors } = validateConfig(configWith(overrides))
  if (!config) {
    throw new Error(`Expected a usable config but got errors: ${errors.join('; ')}`)
  }
  return { config, warnings }
}

/** The fatal problems reported for a config expected to be unusable. */
function errorsFor(overrides: Partial<MyAlarmComPlatformConfig> = {}): string {
  const { config, errors } = validateConfig(configWith(overrides))
  expect(config).toBeNull()
  return errors.join('\n')
}

/**
 * Nothing here throws. Homebridge does not guard a platform constructor, so a
 * thrown error takes down the whole bridge — every other plugin and accessory
 * in the house — over one typo in this plugin's block.
 */
describe('required credentials', () => {
  it('reports a config with no username as unusable', () => {
    expect(errorsFor({ username: undefined })).toMatch(/"username" is required/)
  })

  it('reports a config with no password as unusable', () => {
    expect(errorsFor({ password: undefined })).toMatch(/"password" is required/)
  })

  it('reports a username that is only whitespace', () => {
    expect(errorsFor({ username: '   ' })).toMatch(/"username" is required/)
  })

  it('reports a username that is not a string', () => {
    expect(errorsFor({ username: 42 })).toMatch(/"username" is required/)
  })

  it('reports every fatal problem at once, not just the first', () => {
    const { errors } = validateConfig(configWith({ username: undefined, password: undefined }))

    expect(errors).toHaveLength(2)
  })

  it('trims surrounding whitespace from credentials', () => {
    expect(resolve({ username: '  user@example.com  ' }).config.username).toBe('user@example.com')
  })

  it('reports a value long enough to be a paste error', () => {
    expect(errorsFor({ password: 'x'.repeat(5_000) })).toMatch(/check for a paste error/)
  })
})

describe('the two-factor cookie', () => {
  it('rejects a six-digit authenticator code and explains what is wanted instead', () => {
    const errors = errorsFor({ twoFactorAuthenticationId: '123456' })

    expect(errors).toMatch(/six-digit authenticator code/)
    expect(errors).toMatch(/browser cookie/)
  })

  it('rejects a value that is not a string', () => {
    expect(errorsFor({ twoFactorAuthenticationId: 123456 }))
      .toMatch('"twoFactorAuthenticationId" must be a string')
  })

  /**
   * The value is interpolated straight into a Cookie header, so a pasted whole
   * cookie header would inject a second pair rather than failing with anything
   * a user could act on.
   */
  it('rejects a whole cookie header pasted in place of one value', () => {
    expect(errorsFor({ twoFactorAuthenticationId: 'twoFactorAuthenticationId=abc; other=def' }))
      .toMatch(/not valid in a cookie value/)
  })

  it('warns rather than fails when no cookie is configured', () => {
    const { config, warnings } = resolve({ twoFactorAuthenticationId: undefined })

    expect(config.twoFactorAuthenticationId).toBe('')
    expect(warnings.join('\n')).toMatch(/two-factor authentication disabled/)
  })

  it('warns that a suspiciously short cookie is probably truncated', () => {
    const { config, warnings } = resolve({ twoFactorAuthenticationId: 'abcdef123' })

    expect(config.twoFactorAuthenticationId).toBe('abcdef123')
    expect(warnings.join('\n')).toMatch(/shorter than expected/)
  })

  it('accepts a realistic cookie without complaint', () => {
    const { config, warnings } = resolve()

    expect(config.twoFactorAuthenticationId).toBe(MFA_COOKIE)
    expect(warnings).toEqual([])
  })
})

describe('the poll interval', () => {
  it('raises a too-eager interval to the 60 second floor and says so', () => {
    const { config, warnings } = resolve({ pollIntervalSeconds: 5 })

    expect(config.pollIntervalSeconds).toBe(60)
    expect(warnings.join('\n')).toMatch(/"pollIntervalSeconds" was raised from 5 to 60 seconds/)
    expect(warnings.join('\n')).toMatch(/lock accounts/)
  })

  it('leaves a slower interval alone', () => {
    const { config, warnings } = resolve({ pollIntervalSeconds: 300 })

    expect(config.pollIntervalSeconds).toBe(300)
    expect(warnings).toEqual([])
  })

  it('lowers values above the one-day ceiling with a warning', () => {
    const { config, warnings } = resolve({ pollIntervalSeconds: 100_000 })

    expect(config.pollIntervalSeconds).toBe(86_400)
    expect(warnings.join('\n')).toMatch(/"pollIntervalSeconds" was lowered from 100000 to 86400 seconds/)
  })

  it('falls back to the default when the value is not a number', () => {
    const { config, warnings } = resolve({ pollIntervalSeconds: 'often' })

    expect(config.pollIntervalSeconds).toBe(60)
    expect(warnings.join('\n')).toMatch(/"pollIntervalSeconds" must be a number/)
  })

  it('falls back to the default for a non-finite number', () => {
    const { config } = resolve({ pollIntervalSeconds: Number.POSITIVE_INFINITY })

    expect(config.pollIntervalSeconds).toBe(60)
  })
})

describe('the re-authentication interval', () => {
  it('raises a too-eager interval to the 10 minute floor and says so', () => {
    const { config, warnings } = resolve({ authIntervalMinutes: 1 })

    expect(config.authIntervalMinutes).toBe(10)
    expect(warnings.join('\n')).toMatch(/"authIntervalMinutes" was raised from 1 to 10 minutes/)
  })

  it('leaves a longer interval alone', () => {
    const { config } = resolve({ authIntervalMinutes: 45 })

    expect(config.authIntervalMinutes).toBe(45)
  })

  it('lowers values above the one-day ceiling with a warning', () => {
    const { config, warnings } = resolve({ authIntervalMinutes: 10_000 })

    expect(config.authIntervalMinutes).toBe(1_440)
    expect(warnings.join('\n')).toMatch(/"authIntervalMinutes" was lowered from 10000 to 1440 minutes/)
  })
})

describe('ignoredDeviceIds', () => {
  it('keeps the trimmed string entries', () => {
    const { config } = resolve({ ignoredDeviceIds: [' 1234567-1 ', '1234567-2'] })

    expect([...config.ignoredDeviceIds]).toEqual(['1234567-1', '1234567-2'])
  })

  it('ignores a value that is not a list, with a warning', () => {
    const { config, warnings } = resolve({ ignoredDeviceIds: '1234567-1' })

    expect(config.ignoredDeviceIds.size).toBe(0)
    expect(warnings.join('\n')).toMatch(/"ignoredDeviceIds" must be a list/)
  })

  it('drops entries that are neither strings nor meaningful', () => {
    const { config } = resolve({ ignoredDeviceIds: ['1234567-1', 42, null, '', '  '] })

    expect([...config.ignoredDeviceIds]).toEqual(['1234567-1'])
  })

  it('is empty when omitted', () => {
    expect(resolve().config.ignoredDeviceIds.size).toBe(0)
  })
})

describe('defaults', () => {
  it('fills in every optional setting', () => {
    const { config, warnings } = resolve()

    expect(config).toMatchObject({
      pollIntervalSeconds: 60,
      authIntervalMinutes: 10,
      useEventStream: true,
      includeUnmonitoredSensors: false,
      debug: false,
      diagnosticsInterval: 0,
    })
    expect(warnings).toEqual([])
  })

  /**
   * `name` belongs to Homebridge, which uses it as the log prefix. The plugin
   * never reads it, so validating or resolving it here would be inventing a
   * contract the code does not honour.
   */
  it('leaves the instance name to Homebridge rather than resolving it', () => {
    const { config } = resolve({ name: '  Home Alarm  ' })

    expect(config).not.toHaveProperty('name')
  })

  it('honours the booleans a user sets', () => {
    const { config } = resolve({
      useEventStream: false,
      includeUnmonitoredSensors: true,
      debug: true,
    })

    expect(config).toMatchObject({
      useEventStream: false,
      includeUnmonitoredSensors: true,
      debug: true,
    })
  })

  it('falls back for booleans given as something other than a boolean', () => {
    const { config } = resolve({ useEventStream: 'yes', debug: 1 })

    expect(config.useEventStream).toBe(true)
    expect(config.debug).toBe(false)
  })
})

describe('diagnosticsInterval', () => {
  it('accepts zero and the configured floor', () => {
    expect(resolve({ diagnosticsInterval: 0 }).config.diagnosticsInterval).toBe(0)
    expect(resolve({ diagnosticsInterval: 120 }).config.diagnosticsInterval).toBe(120)
  })

  it('raises sub-floor values with a warning', () => {
    const { config, warnings } = resolve({ diagnosticsInterval: 10 })
    expect(config.diagnosticsInterval).toBe(30)
    expect(warnings[0]).toMatch(/diagnosticsInterval/)
  })

  it('accepts multi-hour intervals within the one-day ceiling', () => {
    const { config, warnings } = resolve({ diagnosticsInterval: 10_800 })

    expect(config.diagnosticsInterval).toBe(10_800)
    expect(warnings).toEqual([])
  })

  it('lowers values above the one-day ceiling with a warning', () => {
    const { config, warnings } = resolve({ diagnosticsInterval: 100_000 })

    expect(config.diagnosticsInterval).toBe(86_400)
    expect(warnings[0]).toMatch(/lowered from 100000 to 86400/)
  })

  it('rounds a fractional interval, matching the integer the schema declares', () => {
    expect(resolve({ diagnosticsInterval: 90.6 }).config.diagnosticsInterval).toBe(91)
  })

  /**
   * Regression. These two branches used to throw while every neighbouring
   * clamp merely warned, so a mistyped *optional* diagnostics interval took
   * down the whole bridge — the exact outcome the function's own comment said
   * it was written to avoid.
   */
  it('disables diagnostics with a warning rather than refusing to start', () => {
    for (const value of ['often', -1, Number.NaN]) {
      const { config, warnings } = resolve({ diagnosticsInterval: value })

      expect(config.diagnosticsInterval).toBe(0)
      expect(warnings.join('\n')).toMatch(/diagnosticsInterval/)
    }
  })
})
