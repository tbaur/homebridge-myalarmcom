/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The version the plugin reports in its `User-Agent` and in every diagnostics
 * report. The interesting part is the fallback: it is what those two consumers
 * get when the read fails, and a thrown error there would take down module load
 * for the whole plugin.
 */

import packageJson from '../../../package.json'

describe('PLUGIN_VERSION', () => {
  afterEach(() => {
    jest.resetModules()
  })

  it('is the version from package.json', async () => {
    const { PLUGIN_VERSION } = await import('../../../src/utils/version')

    expect(PLUGIN_VERSION).toBe(packageJson.version)
  })

  it('falls back to "unknown" rather than throwing when the read fails', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../package.json', () => {
        throw new Error('ENOENT')
      })

      const { PLUGIN_VERSION } = require('../../../src/utils/version') as { PLUGIN_VERSION: string }
      expect(PLUGIN_VERSION).toBe('unknown')
    })
  })

  it('falls back to "unknown" rather than an empty string', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../package.json', () => ({ version: '' }))

      const { PLUGIN_VERSION } = require('../../../src/utils/version') as { PLUGIN_VERSION: string }
      expect(PLUGIN_VERSION).toBe('unknown')
    })
  })
})
