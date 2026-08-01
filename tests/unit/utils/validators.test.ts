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

import { ConfigurationError } from '../../../src/errors'
import type { MyAlarmComPlatformConfig } from '../../../src/types/config'
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

describe('required credentials', () => {
  it('rejects a config with no username', () => {
    expect(() => validateConfig(configWith({ username: undefined }))).toThrow(ConfigurationError)
    expect(() => validateConfig(configWith({ username: undefined }))).toThrow(/"username" is required/)
  })

  it('rejects a config with no password', () => {
    expect(() => validateConfig(configWith({ password: undefined }))).toThrow(ConfigurationError)
    expect(() => validateConfig(configWith({ password: undefined }))).toThrow(/"password" is required/)
  })

  it('rejects a username that is only whitespace', () => {
    expect(() => validateConfig(configWith({ username: '   ' }))).toThrow(ConfigurationError)
  })

  it('rejects a username that is not a string', () => {
    expect(() => validateConfig(configWith({ username: 42 }))).toThrow(ConfigurationError)
  })

  it('trims surrounding whitespace from credentials', () => {
    const { config } = validateConfig(configWith({ username: '  user@example.com  ' }))

    expect(config.username).toBe('user@example.com')
  })
})

describe('the two-factor cookie', () => {
  it('rejects a six-digit authenticator code and explains what is wanted instead', () => {
    const attempt = (): unknown => validateConfig(configWith({ twoFactorAuthenticationId: '123456' }))

    expect(attempt).toThrow(ConfigurationError)
    expect(attempt).toThrow(/six-digit authenticator code/)
    expect(attempt).toThrow(/browser cookie/)
  })

  it('rejects a value that is not a string', () => {
    expect(() => validateConfig(configWith({ twoFactorAuthenticationId: 123456 })))
      .toThrow('"twoFactorAuthenticationId" must be a string')
  })

  it('warns rather than fails when no cookie is configured', () => {
    const { config, warnings } = validateConfig(configWith({ twoFactorAuthenticationId: undefined }))

    expect(config.twoFactorAuthenticationId).toBe('')
    expect(warnings.join('\n')).toMatch(/two-factor authentication disabled/)
  })

  it('warns that a suspiciously short cookie is probably truncated', () => {
    const { config, warnings } = validateConfig(configWith({ twoFactorAuthenticationId: 'abcdef123' }))

    expect(config.twoFactorAuthenticationId).toBe('abcdef123')
    expect(warnings.join('\n')).toMatch(/shorter than expected/)
  })

  it('accepts a realistic cookie without complaint', () => {
    const { config, warnings } = validateConfig(configWith())

    expect(config.twoFactorAuthenticationId).toBe(MFA_COOKIE)
    expect(warnings).toEqual([])
  })
})

describe('the poll interval', () => {
  it('raises a too-eager interval to the 60 second floor and says so', () => {
    const { config, warnings } = validateConfig(configWith({ pollIntervalSeconds: 5 }))

    expect(config.pollIntervalSeconds).toBe(60)
    expect(warnings.join('\n')).toMatch(/"pollIntervalSeconds" was raised from 5 to 60 seconds/)
    expect(warnings.join('\n')).toMatch(/lock accounts/)
  })

  it('leaves a slower interval alone', () => {
    const { config, warnings } = validateConfig(configWith({ pollIntervalSeconds: 300 }))

    expect(config.pollIntervalSeconds).toBe(300)
    expect(warnings).toEqual([])
  })

  it('falls back to the default when the value is not a number', () => {
    const { config, warnings } = validateConfig(configWith({ pollIntervalSeconds: 'often' }))

    expect(config.pollIntervalSeconds).toBe(60)
    expect(warnings.join('\n')).toMatch(/"pollIntervalSeconds" must be a number/)
  })

  it('falls back to the default for a non-finite number', () => {
    const { config } = validateConfig(configWith({ pollIntervalSeconds: Number.POSITIVE_INFINITY }))

    expect(config.pollIntervalSeconds).toBe(60)
  })
})

describe('the re-authentication interval', () => {
  it('raises a too-eager interval to the 10 minute floor and says so', () => {
    const { config, warnings } = validateConfig(configWith({ authIntervalMinutes: 1 }))

    expect(config.authIntervalMinutes).toBe(10)
    expect(warnings.join('\n')).toMatch(/"authIntervalMinutes" was raised from 1 to 10 minutes/)
  })

  it('leaves a longer interval alone', () => {
    const { config } = validateConfig(configWith({ authIntervalMinutes: 45 }))

    expect(config.authIntervalMinutes).toBe(45)
  })
})

describe('ignoredDeviceIds', () => {
  it('keeps the trimmed string entries', () => {
    const { config } = validateConfig(configWith({ ignoredDeviceIds: [' 1234567-1 ', '1234567-2'] }))

    expect([...config.ignoredDeviceIds]).toEqual(['1234567-1', '1234567-2'])
  })

  it('ignores a value that is not a list, with a warning', () => {
    const { config, warnings } = validateConfig(configWith({ ignoredDeviceIds: '1234567-1' }))

    expect(config.ignoredDeviceIds.size).toBe(0)
    expect(warnings.join('\n')).toMatch(/"ignoredDeviceIds" must be a list/)
  })

  it('drops entries that are neither strings nor meaningful', () => {
    const { config } = validateConfig(configWith({ ignoredDeviceIds: ['1234567-1', 42, null, '', '  '] }))

    expect([...config.ignoredDeviceIds]).toEqual(['1234567-1'])
  })

  it('is empty when omitted', () => {
    expect(validateConfig(configWith()).config.ignoredDeviceIds.size).toBe(0)
  })
})

describe('defaults', () => {
  it('fills in every optional setting', () => {
    const { config, warnings } = validateConfig(configWith())

    expect(config).toMatchObject({
      name: 'MyAlarmCom',
      pollIntervalSeconds: 60,
      authIntervalMinutes: 10,
      useEventStream: true,
      includeUnmonitoredSensors: false,
      debug: false,
      diagnosticsInterval: 0,
    })
    expect(warnings).toEqual([])
  })

  it('keeps a user-supplied platform name', () => {
    expect(validateConfig(configWith({ name: '  Home Alarm  ' })).config.name).toBe('Home Alarm')
  })

  it('ignores a name that is blank or not a string', () => {
    // `name` is the one declared-as-string field, so a config file supplying a
    // number can only be reproduced by going around the type.
    const numericName = { name: 7 } as unknown as Partial<MyAlarmComPlatformConfig>

    expect(validateConfig(configWith({ name: '   ' })).config.name).toBe('MyAlarmCom')
    expect(validateConfig(configWith(numericName)).config.name).toBe('MyAlarmCom')
  })

  it('honours the booleans a user sets', () => {
    const { config } = validateConfig(configWith({
      useEventStream: false,
      includeUnmonitoredSensors: true,
      debug: true,
    }))

    expect(config).toMatchObject({
      useEventStream: false,
      includeUnmonitoredSensors: true,
      debug: true,
    })
  })

  it('falls back for booleans given as something other than a boolean', () => {
    const { config } = validateConfig(configWith({ useEventStream: 'yes', debug: 1 }))

    expect(config.useEventStream).toBe(true)
    expect(config.debug).toBe(false)
  })
})

describe('diagnosticsInterval', () => {
  it('accepts zero and the configured floor', () => {
    expect(validateConfig(configWith({ diagnosticsInterval: 0 })).config.diagnosticsInterval).toBe(0)
    expect(validateConfig(configWith({ diagnosticsInterval: 120 })).config.diagnosticsInterval).toBe(120)
  })

  it('raises sub-floor values with a warning', () => {
    const { config, warnings } = validateConfig(configWith({ diagnosticsInterval: 10 }))
    expect(config.diagnosticsInterval).toBe(30)
    expect(warnings[0]).toMatch(/diagnosticsInterval/)
  })

  it('accepts multi-hour intervals within the one-day ceiling', () => {
    const { config, warnings } = validateConfig(configWith({ diagnosticsInterval: 10_800 }))

    expect(config.diagnosticsInterval).toBe(10_800)
    expect(warnings).toEqual([])
  })

  it('lowers values above the one-day ceiling with a warning', () => {
    const { config, warnings } = validateConfig(configWith({ diagnosticsInterval: 100_000 }))

    expect(config.diagnosticsInterval).toBe(86_400)
    expect(warnings[0]).toMatch(/lowered from 100000 to 86400/)
  })

  it('rejects non-numbers', () => {
    expect(() => validateConfig(configWith({ diagnosticsInterval: 'often' }))).toThrow(ConfigurationError)
  })
})
