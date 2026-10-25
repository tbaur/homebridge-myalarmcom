/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Which conditions page, and which failures are the same cause.
 */

import {
  AlarmComSignals,
  ALARM_ACTIVE_SUMMARY,
  AUTH_LOGIN_FORM_SUMMARY,
  AUTH_REJECTED_SUMMARY,
  CLOUD_OFFLINE_GRACE_MS,
  CLOUD_OFFLINE_SUMMARY,
  homebridgeStoragePath,
  PAGERDUTY_STARTUP_LOG,
  SIGNAL_ALARM_ACTIVE,
  SIGNAL_AUTH_FAILED,
  SIGNAL_CLOUD_OFFLINE,
  SIGNAL_SMOKE_ACTIVE,
  SMOKE_ACTIVE_SUMMARY,
  signalFailureFrom,
  type SignalWriter,
} from '../../src/alarmcom-signals'
import type { SignalState } from '../../src/pagerduty-signals'
import {
  AuthenticationError,
  ConfigurationError,
  ForbiddenError,
  LoginFormError,
  NetworkError,
  OperationAbortedError,
  TwoFactorRequiredError,
} from '../../src/errors'

const createWriter = (): SignalWriter & { write: jest.Mock, close: jest.Mock } => {
  const write = jest.fn()
  const close = jest.fn()
  return { write, close }
}

/** The last state written for one signal, or undefined if it was never written. */
const lastState = (
  writer: ReturnType<typeof createWriter>,
  signal: string,
): SignalState | undefined => {
  const calls = writer.write.mock.calls.filter(([name]) => name === signal)
  const last = calls[calls.length - 1]
  return last ? last[1] as SignalState : undefined
}

describe('signalFailureFrom', () => {
  it('ignores a shutdown abort', () => {
    expect(signalFailureFrom(new OperationAbortedError())).toBeUndefined()
  })

  it('treats a rejected password and a rejected two-factor cookie as one failure', () => {
    expect(signalFailureFrom(new AuthenticationError())).toBe('rejected')
    expect(signalFailureFrom(new TwoFactorRequiredError())).toBe('rejected')
  })

  it('distinguishes an unreadable sign-in page from a rejected password', () => {
    expect(signalFailureFrom(new LoginFormError())).toBe('login-form')
  })

  it('treats a miss that will be retried as unreachable', () => {
    expect(signalFailureFrom(new NetworkError('down'))).toBe('unreachable')
    expect(signalFailureFrom(new ForbiddenError('forbidden'))).toBe('unreachable')
    expect(signalFailureFrom(new ConfigurationError('bad'))).toBe('unreachable')
  })
})

describe('homebridgeStoragePath', () => {
  it('returns undefined when Homebridge did not provide a path', () => {
    expect(homebridgeStoragePath({})).toBeUndefined()
    expect(homebridgeStoragePath({ user: null })).toBeUndefined()
    expect(homebridgeStoragePath({ user: {} })).toBeUndefined()
    expect(homebridgeStoragePath({ user: { storagePath: 'not-a-function' } })).toBeUndefined()
    expect(homebridgeStoragePath({ user: { storagePath: () => '' } })).toBeUndefined()
    expect(homebridgeStoragePath({ user: { storagePath: () => 12 } })).toBeUndefined()
  })

  it('returns the path Homebridge provided', () => {
    expect(homebridgeStoragePath({ user: { storagePath: () => '/tmp/homebridge' } }))
      .toBe('/tmp/homebridge')
  })
})

describe('AlarmComSignals', () => {
  let writer: ReturnType<typeof createWriter>
  let signals: AlarmComSignals

  beforeEach(() => {
    jest.useFakeTimers()
    writer = createWriter()
    signals = new AlarmComSignals(writer)
  })

  afterEach(() => {
    signals.close()
    jest.useRealTimers()
  })

  it('names every signal in the startup line, in a fixed order', () => {
    expect(PAGERDUTY_STARTUP_LOG).toBe(
      'homebridge-pagerduty support is enabled (alarm-active, smoke-active, auth-failed, cloud-offline)',
    )
    expect(CLOUD_OFFLINE_GRACE_MS).toBe(5 * 60 * 1000)
  })

  describe('cloud-offline', () => {
    it('turns on only after Alarm.com has been unread for the grace period', () => {
      signals.start()
      jest.advanceTimersByTime(CLOUD_OFFLINE_GRACE_MS - 1)
      expect(lastState(writer, SIGNAL_CLOUD_OFFLINE)).toBeUndefined()

      jest.advanceTimersByTime(1)
      expect(lastState(writer, SIGNAL_CLOUD_OFFLINE)).toEqual({
        active: true,
        severity: 'error',
        summary: CLOUD_OFFLINE_SUMMARY,
      })
    })

    it('does not extend the grace when the failure is reported again', () => {
      signals.start()
      jest.advanceTimersByTime(CLOUD_OFFLINE_GRACE_MS - 1_000)
      signals.noteUnreachable()
      jest.advanceTimersByTime(1_000)

      expect(lastState(writer, SIGNAL_CLOUD_OFFLINE)).toMatchObject({ active: true })
    })

    it('does not page for an outage shorter than the grace period', () => {
      signals.start()
      jest.advanceTimersByTime(CLOUD_OFFLINE_GRACE_MS - 1_000)
      signals.noteReached()
      signals.noteUnreachable()
      jest.advanceTimersByTime(CLOUD_OFFLINE_GRACE_MS - 1_000)
      signals.noteReached()
      jest.advanceTimersByTime(CLOUD_OFFLINE_GRACE_MS)

      const writes = writer.write.mock.calls.filter(([name]) => name === SIGNAL_CLOUD_OFFLINE)
      expect(writes.every(([, state]) => state.active === false)).toBe(true)
    })

    it('clears as soon as a device read succeeds', () => {
      signals.start()
      jest.advanceTimersByTime(CLOUD_OFFLINE_GRACE_MS)
      signals.noteReached()

      expect(lastState(writer, SIGNAL_CLOUD_OFFLINE)).toMatchObject({ active: false })
      expect(lastState(writer, SIGNAL_AUTH_FAILED)).toMatchObject({ active: false })
    })

    it('starts the grace again after a later outage', () => {
      signals.noteReached()
      signals.noteUnreachable()
      jest.advanceTimersByTime(CLOUD_OFFLINE_GRACE_MS)

      expect(lastState(writer, SIGNAL_CLOUD_OFFLINE)).toMatchObject({ active: true, severity: 'error' })
    })
  })

  describe('auth-failed', () => {
    it('turns on immediately when the password or cookie is rejected', () => {
      signals.noteSignInStopped('rejected')

      expect(lastState(writer, SIGNAL_AUTH_FAILED)).toEqual({
        active: true,
        severity: 'error',
        summary: AUTH_REJECTED_SUMMARY,
      })
    })

    it('says the plugin needs an update when the sign-in page cannot be read', () => {
      signals.noteSignInStopped('login-form')

      expect(lastState(writer, SIGNAL_AUTH_FAILED)).toEqual({
        active: true,
        severity: 'error',
        summary: AUTH_LOGIN_FORM_SUMMARY,
      })
    })

    it('keeps cloud-offline off while sign-in is stopped', () => {
      signals.start()
      signals.noteSignInStopped('rejected')
      signals.noteUnreachable()
      jest.advanceTimersByTime(CLOUD_OFFLINE_GRACE_MS)

      expect(lastState(writer, SIGNAL_CLOUD_OFFLINE)).toMatchObject({ active: false })
      expect(lastState(writer, SIGNAL_AUTH_FAILED)).toMatchObject({ active: true })
    })

    it('clears an open cloud-offline page, because Alarm.com answered', () => {
      signals.start()
      jest.advanceTimersByTime(CLOUD_OFFLINE_GRACE_MS)
      signals.noteSignInStopped('rejected')

      expect(lastState(writer, SIGNAL_CLOUD_OFFLINE)).toMatchObject({ active: false })
    })

    it('clears after a later successful read', () => {
      signals.noteSignInStopped('rejected')
      signals.noteReached()

      expect(lastState(writer, SIGNAL_AUTH_FAILED)).toEqual({
        active: false,
        severity: 'error',
        summary: AUTH_REJECTED_SUMMARY,
      })
    })

    it('does not write alarm or smoke', () => {
      signals.noteSignInStopped('rejected')

      expect(lastState(writer, SIGNAL_ALARM_ACTIVE)).toBeUndefined()
      expect(lastState(writer, SIGNAL_SMOKE_ACTIVE)).toBeUndefined()
    })
  })

  describe('alarm and smoke', () => {
    it('writes both from a finished device read', () => {
      signals.noteDevices({ alarmActive: true, smokeActive: true })

      expect(lastState(writer, SIGNAL_ALARM_ACTIVE)).toEqual({
        active: true,
        severity: 'critical',
        summary: ALARM_ACTIVE_SUMMARY,
      })
      expect(lastState(writer, SIGNAL_SMOKE_ACTIVE)).toEqual({
        active: true,
        severity: 'critical',
        summary: SMOKE_ACTIVE_SUMMARY,
      })
    })

    it('writes them clear when the read says so', () => {
      signals.noteDevices({ alarmActive: true, smokeActive: true })
      signals.noteDevices({ alarmActive: false, smokeActive: false })

      expect(lastState(writer, SIGNAL_ALARM_ACTIVE)).toMatchObject({ active: false })
      expect(lastState(writer, SIGNAL_SMOKE_ACTIVE)).toMatchObject({ active: false })
    })
  })

  describe('close', () => {
    it('closes the writer, stops the grace timer, and never clears a signal', () => {
      signals.noteSignInStopped('rejected')
      signals.start()
      writer.write.mockClear()

      signals.close()
      jest.advanceTimersByTime(CLOUD_OFFLINE_GRACE_MS)
      signals.noteReached()
      signals.noteDevices({ alarmActive: false, smokeActive: false })
      signals.noteUnreachable()
      signals.noteSignInStopped('login-form')
      signals.close()

      expect(writer.close.mock.calls).toHaveLength(1)
      expect(writer.write.mock.calls).toHaveLength(0)
    })
  })
})
