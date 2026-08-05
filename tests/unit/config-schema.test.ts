/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * `config.schema.json` is the Homebridge UI's copy of the configuration
 * contract, and it restates every bound the validator enforces. Nothing checked
 * that the two agreed, so the UI could quietly advertise a range the runtime
 * would clamp — and a user editing `config.json` by hand got different answers
 * from one editing it in the UI.
 */

import schema from '../../config.schema.json'
import {
  DEFAULT_AUTH_INTERVAL_MIN,
  DEFAULT_POLL_INTERVAL_SEC,
  MAX_AUTH_INTERVAL_MIN,
  MAX_DIAGNOSTICS_INTERVAL_SEC,
  MAX_POLL_INTERVAL_SEC,
  MIN_AUTH_INTERVAL_MIN,
  MIN_DIAGNOSTICS_INTERVAL_SEC,
  MIN_POLL_INTERVAL_SEC,
  PLATFORM_NAME,
} from '../../src/settings'
import type { MyAlarmComPlatformConfig, ResolvedConfig } from '../../src/types/config'
import { validateConfig } from '../../src/utils/validators'

const properties: Record<string, {
  type?: string
  default?: unknown
  minimum?: number
  maximum?: number
}> = schema.schema.properties

describe('config.schema.json', () => {
  it('registers the platform under the name the plugin does', () => {
    expect(schema.pluginAlias).toBe(PLATFORM_NAME)
    expect(schema.pluginType).toBe('platform')
  })

  it('declares exactly the options the resolved config carries, plus the ones Homebridge owns', () => {
    const { config } = validateConfig({
      platform: PLATFORM_NAME,
      username: 'user@example.com',
      password: 'correct-horse-battery',
    })
    // `name` is Homebridge's, not the plugin's, so it appears in the schema but
    // never in the resolved config. `platform` is supplied by Homebridge itself.
    const homebridgeOwned = ['name']

    const declared = Object.keys(properties).sort()
    const resolved = [...Object.keys(config as ResolvedConfig), ...homebridgeOwned].sort()

    expect(declared).toEqual(resolved)
  })

  describe('numeric bounds match the constants the runtime enforces', () => {
    it.each([
      ['pollIntervalSeconds', DEFAULT_POLL_INTERVAL_SEC, MIN_POLL_INTERVAL_SEC, MAX_POLL_INTERVAL_SEC],
      ['authIntervalMinutes', DEFAULT_AUTH_INTERVAL_MIN, MIN_AUTH_INTERVAL_MIN, MAX_AUTH_INTERVAL_MIN],
      // Diagnostics allows 0 (off) below its working floor, so the schema
      // minimum is 0 and the floor is asserted through the validator instead.
      ['diagnosticsInterval', 0, 0, MAX_DIAGNOSTICS_INTERVAL_SEC],
    ])('%s', (option, expectedDefault, minimum, maximum) => {
      expect(properties[option]).toMatchObject({
        type: 'integer',
        default: expectedDefault,
        minimum,
        maximum,
      })
    })

    it('raises a diagnostics interval below the working floor, as its description says', () => {
      const raw: MyAlarmComPlatformConfig = {
        platform: PLATFORM_NAME,
        username: 'user@example.com',
        password: 'correct-horse-battery',
        diagnosticsInterval: MIN_DIAGNOSTICS_INTERVAL_SEC - 1,
      }

      expect(validateConfig(raw).config?.diagnosticsInterval).toBe(MIN_DIAGNOSTICS_INTERVAL_SEC)
      expect(properties.diagnosticsInterval?.type).toBe('integer')
    })
  })

  describe('boolean defaults match what the validator resolves', () => {
    it.each(['useEventStream', 'includeUnmonitoredSensors', 'debug'] as const)('%s', (option) => {
      const { config } = validateConfig({
        platform: PLATFORM_NAME,
        username: 'user@example.com',
        password: 'correct-horse-battery',
      })

      expect(properties[option]?.type).toBe('boolean')
      expect(properties[option]?.default).toBe(config?.[option])
    })
  })

  it('declares an empty default for the ignore list, matching the validator', () => {
    expect(properties.ignoredDeviceIds).toMatchObject({ type: 'array', default: [] })
  })

  /**
   * Alarm.com usernames are not required to be email addresses, and the
   * validator does not require one. Declaring `format: "email"` made the UI
   * refuse a credential that `config.json` would have accepted.
   */
  it('does not impose a format the validator will not enforce', () => {
    expect(properties.username).not.toHaveProperty('format')
  })

  /**
   * The two secrets are what the Homebridge UI would otherwise render in
   * plaintext on a shared screen, and each is a single missing key away from
   * doing so.
   */
  it('marks both credentials as password fields for the Homebridge UI', () => {
    for (const key of ['password', 'twoFactorAuthenticationId']) {
      expect(properties[key]).toMatchObject({ 'x-schema-form': { type: 'password' } })
    }
  })

  /**
   * Without these the UI accepts an empty form and the platform starts, logs its
   * validation errors, and publishes nothing — a far worse first experience than
   * being told which field is missing.
   */
  it('requires the two credentials the validator treats as fatal', () => {
    expect(properties.username).toMatchObject({ required: true })
    expect(properties.password).toMatchObject({ required: true })
  })

  it('lays out every declared option, so none is unreachable in the UI', () => {
    const laidOut = new Set<string>()
    for (const section of schema.layout) {
      for (const item of section.items) {
        laidOut.add(typeof item === 'string' ? item : item.key)
      }
    }

    expect([...laidOut].sort()).toEqual(Object.keys(properties).sort())
  })
})
