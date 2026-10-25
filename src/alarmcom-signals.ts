/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Decides which Alarm.com conditions are worth a PagerDuty page.
 *
 * The store writer is the copied module. This file only chooses when a signal
 * is active. It does not read the store: the four names are fixed, so there
 * is no stale row to look up.
 */

import { AuthenticationError, LoginFormError, OperationAbortedError } from './errors'
import { PagerDutySignals } from './pagerduty-signals'
import type { PagerDutySignalsOptions, SignalState } from './pagerduty-signals'

/** Logged once, in this order, when the setting is on. */
export const PAGERDUTY_STARTUP_LOG =
  'homebridge-pagerduty support is enabled (alarm-active, smoke-active, auth-failed, cloud-offline)'

export const SIGNAL_ALARM_ACTIVE = 'alarm-active'
export const SIGNAL_SMOKE_ACTIVE = 'smoke-active'
export const SIGNAL_AUTH_FAILED = 'auth-failed'
export const SIGNAL_CLOUD_OFFLINE = 'cloud-offline'

/**
 * How long a device read must keep failing before `cloud-offline` turns on.
 *
 * homebridge-pagerduty pages on the write, with no delay of its own. A single
 * poll failure is not an outage.
 */
export const CLOUD_OFFLINE_GRACE_MS = 5 * 60 * 1000

export const ALARM_ACTIVE_SUMMARY = 'The security system is in alarm.'
export const SMOKE_ACTIVE_SUMMARY = 'A smoke detector is active.'
export const AUTH_REJECTED_SUMMARY =
  'Alarm.com rejected the sign-in. This plugin has stopped until the username, password, or two-factor cookie is corrected in Homebridge.'
export const AUTH_LOGIN_FORM_SUMMARY =
  "Alarm.com's sign-in page could not be read. This plugin has stopped until it is updated."
export const CLOUD_OFFLINE_SUMMARY =
  'Homebridge has not reached Alarm.com for 5 minutes. Panel state in HomeKit may be stale.'

/** Why sign-in stopped. The summary depends on it; the signal name does not. */
export type SignInFailure = 'rejected' | 'login-form'

/** What a caught error means for the two account signals, if anything. */
export type SignalFailure = SignInFailure | 'unreachable'

/** The panel and smoke conditions, taken from devices this plugin is publishing. */
export interface DeviceSignalState {
  alarmActive: boolean
  smokeActive: boolean
}

/** The subset of {@link PagerDutySignals} this class uses. */
export interface SignalWriter {
  write(signal: string, state: SignalState): void
  close(): void
}

/**
 * Classify a failure for the signal store.
 *
 * `undefined` means the failure says nothing about Alarm.com: shutdown
 * cancelled the work. A rejected sign-in and an unreadable login page both
 * stop the plugin. Everything else is one more moment without a device read.
 */
export function signalFailureFrom(error: unknown): SignalFailure | undefined {
  if (error instanceof OperationAbortedError) {
    return undefined
  }
  if (error instanceof LoginFormError) {
    return 'login-form'
  }
  if (error instanceof AuthenticationError) {
    return 'rejected'
  }
  return 'unreachable'
}

/**
 * `api.user.storagePath()`, or undefined when Homebridge did not provide one.
 *
 * An empty string is missing. Joining it would create the store in the
 * process's current directory.
 */
export function homebridgeStoragePath(api: object): string | undefined {
  if (!('user' in api)) {
    return undefined
  }
  const user: unknown = api.user
  if (typeof user !== 'object' || user === null || !('storagePath' in user)) {
    return undefined
  }
  const readPath: unknown = user.storagePath
  if (typeof readPath !== 'function') {
    return undefined
  }
  const storagePath: unknown = (readPath as () => unknown).call(user)
  if (typeof storagePath !== 'string' || storagePath.length === 0) {
    return undefined
  }
  return storagePath
}

/**
 * Tracks this plugin's four PagerDuty signals.
 *
 * Alarm and smoke are written only from a finished device read. Account
 * signals are written from sign-in and from reachability. Shutdown closes
 * the writer and leaves every row as it was.
 */
export class AlarmComSignals {
  readonly #writer: SignalWriter
  readonly #graceMs: number
  #offlineTimer: ReturnType<typeof setTimeout> | null = null
  #isCloudOfflineConfirmed = false
  #isAuthRejected = false
  #hasStarted = false
  #isClosed = false

  constructor(writer: SignalWriter, graceMs = CLOUD_OFFLINE_GRACE_MS) {
    this.#writer = writer
    this.#graceMs = graceMs
  }

  /**
   * Start the offline grace.
   *
   * Does not write. Call once, before the first request, so an outage that is
   * already under way at launch still pages.
   */
  start(): void {
    if (this.#isClosed || this.#hasStarted) {
      return
    }
    this.#hasStarted = true
    if (!this.#isAuthRejected) {
      this.#armOfflineGrace()
    }
  }

  /**
   * A device read succeeded.
   *
   * Clears the offline grace. A successful read means the sign-in worked, so
   * `auth-failed` clears as well.
   */
  noteReached(): void {
    if (this.#isClosed) {
      return
    }
    this.#isAuthRejected = false
    this.#isCloudOfflineConfirmed = false
    this.#clearOfflineTimer()
    this.#writeAuth(false, 'rejected')
    this.#writeCloud()
  }

  /**
   * Alarm.com did not answer, and the failure will be retried.
   *
   * The grace runs from the first report. Later failures do not push it out.
   * It stays disarmed while `auth-failed` is on, so one cause sends one page.
   */
  noteUnreachable(): void {
    if (this.#isClosed || this.#isAuthRejected) {
      return
    }
    this.#armOfflineGrace()
  }

  /**
   * Sign-in has stopped and will not be retried.
   *
   * Alarm.com answered, so `cloud-offline` clears. Alarm and smoke are left
   * untouched: this call does not know whether the panel is in alarm.
   */
  noteSignInStopped(failure: SignInFailure): void {
    if (this.#isClosed) {
      return
    }
    this.#isAuthRejected = true
    this.#isCloudOfflineConfirmed = false
    this.#clearOfflineTimer()
    this.#writeAuth(true, failure)
    this.#writeCloud()
  }

  /**
   * Write the panel and smoke signals from a completed device read.
   *
   * Call this only after the read has finished. Writing a clear part way
   * through would resolve an open alarm and open it again a moment later.
   */
  noteDevices(state: DeviceSignalState): void {
    if (this.#isClosed) {
      return
    }
    this.#writer.write(SIGNAL_ALARM_ACTIVE, {
      active: state.alarmActive,
      severity: 'critical',
      summary: ALARM_ACTIVE_SUMMARY,
    })
    this.#writer.write(SIGNAL_SMOKE_ACTIVE, {
      active: state.smokeActive,
      severity: 'critical',
      summary: SMOKE_ACTIVE_SUMMARY,
    })
  }

  /** Close the store and stop the grace timer. Does not clear any signal. */
  close(): void {
    if (this.#isClosed) {
      return
    }
    this.#isClosed = true
    this.#clearOfflineTimer()
    this.#writer.close()
  }

  #armOfflineGrace(): void {
    if (this.#offlineTimer !== null || this.#isCloudOfflineConfirmed) {
      return
    }
    this.#offlineTimer = setTimeout(() => {
      this.#offlineTimer = null
      if (this.#isClosed) {
        return
      }
      this.#isCloudOfflineConfirmed = true
      this.#writeCloud()
    }, this.#graceMs)
    this.#offlineTimer.unref?.()
  }

  #clearOfflineTimer(): void {
    if (this.#offlineTimer !== null) {
      clearTimeout(this.#offlineTimer)
      this.#offlineTimer = null
    }
  }

  #writeAuth(active: boolean, failure: SignInFailure): void {
    this.#writer.write(SIGNAL_AUTH_FAILED, {
      active,
      severity: 'error',
      summary: failure === 'login-form' ? AUTH_LOGIN_FORM_SUMMARY : AUTH_REJECTED_SUMMARY,
    })
  }

  #writeCloud(): void {
    this.#writer.write(SIGNAL_CLOUD_OFFLINE, {
      active: this.#isCloudOfflineConfirmed && !this.#isAuthRejected,
      severity: 'error',
      summary: CLOUD_OFFLINE_SUMMARY,
    })
  }
}

/** Build the signals for this plugin, backed by the homebridge-pagerduty store. */
export function createAlarmComSignals(options: PagerDutySignalsOptions): AlarmComSignals {
  return new AlarmComSignals(new PagerDutySignals(options))
}
