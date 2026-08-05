/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The entry point Homebridge calls. Three lines, and a mismatch in any of them
 * means the plugin silently fails to load — which is indistinguishable, from the
 * user's side, from the plugin not working.
 */

import type { API } from 'homebridge'
import registerPlugin from '../../src/index'
import { MyAlarmComPlatform } from '../../src/platform'
import { PLATFORM_NAME, PLUGIN_NAME } from '../../src/settings'
import packageJson from '../../package.json'

describe('the plugin entry point', () => {
  it('registers the platform under the names Homebridge will look for', () => {
    const registerPlatform = jest.fn()

    registerPlugin({ registerPlatform } as unknown as API)

    expect(registerPlatform).toHaveBeenCalledTimes(1)
    expect(registerPlatform).toHaveBeenCalledWith(PLUGIN_NAME, PLATFORM_NAME, MyAlarmComPlatform)
  })

  /**
   * Homebridge resolves a plugin by its package name, so `PLUGIN_NAME` drifting
   * from `package.json` means every user's config stops matching.
   */
  it('uses the published package name as the plugin name', () => {
    expect(PLUGIN_NAME).toBe(packageJson.name)
  })
})
