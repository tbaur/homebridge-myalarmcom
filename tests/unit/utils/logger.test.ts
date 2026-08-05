/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Every plugin log line goes through this wrapper, which is what makes
 * redaction impossible to forget at an individual call site.
 */

import { createScopedLogger } from '../../../src/utils/logger'
import { createRecordingLogger } from '../../helpers/logger'

describe('createScopedLogger', () => {
  it('does not prefix messages with a component scope', () => {
    const base = createRecordingLogger()

    createScopedLogger(base, 'auth', false).info('Signing in to Alarm.com')

    expect(base.info).toHaveBeenCalledWith('Signing in to Alarm.com')
  })

  it('reports whether debug output is enabled, so callers can skip payload work', () => {
    const base = createRecordingLogger()

    expect(createScopedLogger(base, 'api', true).isDebugEnabled).toBe(true)
    expect(createScopedLogger(base, 'api', false).isDebugEnabled).toBe(false)
  })

  it('redacts secrets at every level', () => {
    const base = createRecordingLogger()
    const log = createScopedLogger(base, 'api', true)

    log.debug('sending afg=a3f9c1e2b7d4')
    log.info('sending afg=a3f9c1e2b7d4')
    log.warn('sending afg=a3f9c1e2b7d4')
    log.error('sending afg=a3f9c1e2b7d4')

    for (const level of [base.debug, base.info, base.warn, base.error]) {
      expect(level).toHaveBeenCalledWith(expect.stringContaining('afg=***'))
      expect(level).not.toHaveBeenCalledWith(expect.stringContaining('a3f9c1e2b7d4'))
    }
  })

  it('drops debug messages entirely when debugging is off', () => {
    const base = createRecordingLogger()

    createScopedLogger(base, 'api', false).debug('verbose detail')

    expect(base.debug).not.toHaveBeenCalled()
  })

  it('passes debug messages through when debugging is on', () => {
    const base = createRecordingLogger()

    createScopedLogger(base, 'api', true).debug('verbose detail')

    expect(base.debug).toHaveBeenCalledWith('verbose detail')
  })

  it('forwards additional parameters, preserving detail that is not sensitive', () => {
    const base = createRecordingLogger()

    createScopedLogger(base, 'api', true).warn('unexpected reading', { deviceId: '1234567-1' })

    expect(base.warn).toHaveBeenCalledWith(
      'unexpected reading',
      expect.stringContaining('1234567-1'),
    )
  })

  /**
   * Regression. Only the message was sanitized, so a secret passed as a
   * parameter reached Homebridge verbatim while this wrapper's own
   * documentation promised that could not happen.
   */
  describe('parameters, not just the message', () => {
    it('redacts a secret passed as a string parameter', () => {
      const base = createRecordingLogger()

      createScopedLogger(base, 'api', true)
        .debug('cookie header is', 'afg=a3f9c1e2b7d4; twoFactorAuthenticationId=trust-me')

      const [, parameter] = base.debug.mock.calls[0] as [string, string]
      expect(parameter).not.toContain('a3f9c1e2b7d4')
      expect(parameter).not.toContain('trust-me')
    })

    it('redacts secrets nested inside an object parameter', () => {
      const base = createRecordingLogger()

      createScopedLogger(base, 'api', true)
        .error('request failed', { password: 'correct-horse', cookieHeader: 'afg=a3f9c1e2b7d4' })

      const [, parameter] = base.error.mock.calls[0] as [string, string]
      expect(parameter).not.toContain('correct-horse')
      expect(parameter).not.toContain('a3f9c1e2b7d4')
    })

    it('redacts the message of an Error passed as a parameter', () => {
      const base = createRecordingLogger()

      createScopedLogger(base, 'api', true)
        .error('login failed', new Error('rejected afg=a3f9c1e2b7d4'))

      const [, parameter] = base.error.mock.calls[0] as [string, string]
      expect(parameter).not.toContain('a3f9c1e2b7d4')
    })

    it('leaves primitives alone so numeric detail stays readable', () => {
      const base = createRecordingLogger()

      createScopedLogger(base, 'api', true).info('retrying', 3, true, null)

      expect(base.info).toHaveBeenCalledWith('retrying', 3, true, null)
    })

    it('survives a parameter that cannot be serialized', () => {
      const base = createRecordingLogger()
      const circular: Record<string, unknown> = {}
      circular.self = circular

      expect(() => createScopedLogger(base, 'api', true).info('state', circular)).not.toThrow()
      expect(base.info).toHaveBeenCalled()
    })
  })

  /**
   * The redaction cost is paid per pass, in the polling hot path. Callers must
   * wrap the raw Homebridge logger; this documents that nesting does not invent
   * component prefixes (and still costs a second redaction pass).
   */
  it('keeps nested wrappers from inventing component prefixes', () => {
    const base = createRecordingLogger()

    createScopedLogger(createScopedLogger(base, 'platform', true), 'contact', true).info('added')

    expect(base.info).toHaveBeenCalledWith('added')
  })
})
