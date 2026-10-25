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
import type { PagerDutySignalsOptions, SignalState } from './pagerduty-signals';
/** Logged once, in this order, when the setting is on. */
export declare const PAGERDUTY_STARTUP_LOG = "homebridge-pagerduty support is enabled (alarm-active, smoke-active, auth-failed, cloud-offline)";
export declare const SIGNAL_ALARM_ACTIVE = "alarm-active";
export declare const SIGNAL_SMOKE_ACTIVE = "smoke-active";
export declare const SIGNAL_AUTH_FAILED = "auth-failed";
export declare const SIGNAL_CLOUD_OFFLINE = "cloud-offline";
/**
 * How long a device read must keep failing before `cloud-offline` turns on.
 *
 * homebridge-pagerduty pages on the write, with no delay of its own. A single
 * poll failure is not an outage.
 */
export declare const CLOUD_OFFLINE_GRACE_MS: number;
export declare const ALARM_ACTIVE_SUMMARY = "The security system is in alarm.";
export declare const SMOKE_ACTIVE_SUMMARY = "A smoke detector is active.";
export declare const AUTH_REJECTED_SUMMARY = "Alarm.com rejected the sign-in. This plugin has stopped until the username, password, or two-factor cookie is corrected in Homebridge.";
export declare const AUTH_LOGIN_FORM_SUMMARY = "Alarm.com's sign-in page could not be read. This plugin has stopped until it is updated.";
export declare const CLOUD_OFFLINE_SUMMARY = "Homebridge has not reached Alarm.com for 5 minutes. Panel state in HomeKit may be stale.";
/** Why sign-in stopped. The summary depends on it; the signal name does not. */
export type SignInFailure = 'rejected' | 'login-form';
/** What a caught error means for the two account signals, if anything. */
export type SignalFailure = SignInFailure | 'unreachable';
/** The panel and smoke conditions, taken from devices this plugin is publishing. */
export interface DeviceSignalState {
    alarmActive: boolean;
    smokeActive: boolean;
}
/** The subset of {@link PagerDutySignals} this class uses. */
export interface SignalWriter {
    write(signal: string, state: SignalState): void;
    close(): void;
}
/**
 * Classify a failure for the signal store.
 *
 * `undefined` means the failure says nothing about Alarm.com: shutdown
 * cancelled the work. A rejected sign-in and an unreadable login page both
 * stop the plugin. Everything else is one more moment without a device read.
 */
export declare function signalFailureFrom(error: unknown): SignalFailure | undefined;
/**
 * `api.user.storagePath()`, or undefined when Homebridge did not provide one.
 *
 * An empty string is missing. Joining it would create the store in the
 * process's current directory.
 */
export declare function homebridgeStoragePath(api: object): string | undefined;
/**
 * Tracks this plugin's four PagerDuty signals.
 *
 * Alarm and smoke are written only from a finished device read. Account
 * signals are written from sign-in and from reachability. Shutdown closes
 * the writer and leaves every row as it was.
 */
export declare class AlarmComSignals {
    #private;
    constructor(writer: SignalWriter, graceMs?: number);
    /**
     * Start the offline grace.
     *
     * Does not write. Call once, before the first request, so an outage that is
     * already under way at launch still pages.
     */
    start(): void;
    /**
     * A device read succeeded.
     *
     * Clears the offline grace. A successful read means the sign-in worked, so
     * `auth-failed` clears as well.
     */
    noteReached(): void;
    /**
     * Alarm.com did not answer, and the failure will be retried.
     *
     * The grace runs from the first report. Later failures do not push it out.
     * It stays disarmed while `auth-failed` is on, so one cause sends one page.
     */
    noteUnreachable(): void;
    /**
     * Sign-in has stopped and will not be retried.
     *
     * Alarm.com answered, so `cloud-offline` clears. Alarm and smoke are left
     * untouched: this call does not know whether the panel is in alarm.
     */
    noteSignInStopped(failure: SignInFailure): void;
    /**
     * Write the panel and smoke signals from a completed device read.
     *
     * Call this only after the read has finished. Writing a clear part way
     * through would resolve an open alarm and open it again a moment later.
     */
    noteDevices(state: DeviceSignalState): void;
    /** Close the store and stop the grace timer. Does not clear any signal. */
    close(): void;
}
/** Build the signals for this plugin, backed by the homebridge-pagerduty store. */
export declare function createAlarmComSignals(options: PagerDutySignalsOptions): AlarmComSignals;
//# sourceMappingURL=alarmcom-signals.d.ts.map