"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AlarmComSignals = exports.CLOUD_OFFLINE_SUMMARY = exports.AUTH_LOGIN_FORM_SUMMARY = exports.AUTH_REJECTED_SUMMARY = exports.SMOKE_ACTIVE_SUMMARY = exports.ALARM_ACTIVE_SUMMARY = exports.CLOUD_OFFLINE_GRACE_MS = exports.SIGNAL_CLOUD_OFFLINE = exports.SIGNAL_AUTH_FAILED = exports.SIGNAL_SMOKE_ACTIVE = exports.SIGNAL_ALARM_ACTIVE = exports.PAGERDUTY_STARTUP_LOG = void 0;
exports.signalFailureFrom = signalFailureFrom;
exports.observedSignal = observedSignal;
exports.createAlarmComSignals = createAlarmComSignals;
const errors_1 = require("./errors");
const pagerduty_signals_1 = require("./pagerduty-signals");
/** Logged once, in this order, when the setting is on. */
exports.PAGERDUTY_STARTUP_LOG = 'homebridge-pagerduty support is enabled (alarm-active, smoke-active, auth-failed, cloud-offline)';
exports.SIGNAL_ALARM_ACTIVE = 'alarm-active';
exports.SIGNAL_SMOKE_ACTIVE = 'smoke-active';
exports.SIGNAL_AUTH_FAILED = 'auth-failed';
exports.SIGNAL_CLOUD_OFFLINE = 'cloud-offline';
/**
 * How long a device read must keep failing before `cloud-offline` turns on.
 *
 * homebridge-pagerduty pages on the write, with no delay of its own. A single
 * poll failure is not an outage.
 */
exports.CLOUD_OFFLINE_GRACE_MS = 5 * 60 * 1000;
exports.ALARM_ACTIVE_SUMMARY = 'The security system is in alarm.';
exports.SMOKE_ACTIVE_SUMMARY = 'A smoke detector is active.';
exports.AUTH_REJECTED_SUMMARY = 'Alarm.com rejected the sign-in. This plugin has stopped until the username, password, or two-factor cookie is corrected in Homebridge.';
exports.AUTH_LOGIN_FORM_SUMMARY = "Alarm.com's sign-in page could not be read. This plugin has stopped until it is updated.";
exports.CLOUD_OFFLINE_SUMMARY = 'Homebridge has not reached Alarm.com for 5 minutes. Panel state in HomeKit may be stale.';
/**
 * Classify a failure for the signal store.
 *
 * `undefined` means the failure says nothing about Alarm.com: shutdown
 * cancelled the work. A rejected sign-in and an unreadable login page both
 * stop the plugin. Everything else is one more moment without a device read.
 */
function signalFailureFrom(error) {
    if (error instanceof errors_1.OperationAbortedError) {
        return undefined;
    }
    if (error instanceof errors_1.LoginFormError) {
        return 'login-form';
    }
    if (error instanceof errors_1.AuthenticationError) {
        return 'rejected';
    }
    return 'unreachable';
}
/**
 * Whether a house-level signal is active after a read.
 *
 * A positive reading is enough to page. A clear is written only when every
 * requested device came back, so a missing detail cannot resolve an open page.
 */
function observedSignal(sawActive, isComplete) {
    if (sawActive) {
        return true;
    }
    if (isComplete) {
        return false;
    }
    return undefined;
}
/**
 * Tracks this plugin's four PagerDuty signals.
 *
 * Alarm and smoke are written only from a finished device read. Account
 * signals are written from sign-in and from reachability. Shutdown closes
 * the writer and leaves every row as it was.
 */
class AlarmComSignals {
    #writer;
    #graceMs;
    #offlineTimer = null;
    #isCloudOfflineConfirmed = false;
    #isAuthRejected = false;
    #hasStarted = false;
    #isClosed = false;
    constructor(writer, graceMs = exports.CLOUD_OFFLINE_GRACE_MS) {
        this.#writer = writer;
        this.#graceMs = graceMs;
    }
    /**
     * Start the offline grace.
     *
     * Does not write. Call once, before the first request, so an outage that is
     * already under way at launch still pages.
     */
    start() {
        if (this.#isClosed || this.#hasStarted) {
            return;
        }
        this.#hasStarted = true;
        if (!this.#isAuthRejected) {
            this.#armOfflineGrace();
        }
    }
    /**
     * A device read succeeded.
     *
     * Clears the offline grace. A successful read means the sign-in worked, so
     * `auth-failed` clears as well.
     */
    noteReached() {
        if (this.#isClosed) {
            return;
        }
        this.#isAuthRejected = false;
        this.#isCloudOfflineConfirmed = false;
        this.#clearOfflineTimer();
        this.#writeAuth(false, 'rejected');
        this.#writeCloud();
    }
    /**
     * Alarm.com did not answer, and the failure will be retried.
     *
     * The grace runs from the first report. Later failures do not push it out.
     * It stays disarmed while `auth-failed` is on, so one cause sends one page.
     */
    noteUnreachable() {
        if (this.#isClosed || this.#isAuthRejected) {
            return;
        }
        this.#armOfflineGrace();
    }
    /**
     * Sign-in has stopped and will not be retried.
     *
     * Alarm.com answered, so `cloud-offline` clears. Alarm and smoke are left
     * untouched: this call does not know whether the panel is in alarm.
     */
    noteSignInStopped(failure) {
        if (this.#isClosed) {
            return;
        }
        this.#isAuthRejected = true;
        this.#isCloudOfflineConfirmed = false;
        this.#clearOfflineTimer();
        this.#writeAuth(true, failure);
        this.#writeCloud();
    }
    /**
     * Write the panel and smoke signals from a completed device read.
     *
     * Call this only after the read has finished. Writing a clear part way
     * through would resolve an open alarm and open it again a moment later.
     */
    noteDevices(state) {
        if (this.#isClosed) {
            return;
        }
        if (state.alarmActive !== undefined) {
            this.#writer.write(exports.SIGNAL_ALARM_ACTIVE, {
                active: state.alarmActive,
                severity: 'critical',
                summary: exports.ALARM_ACTIVE_SUMMARY,
            });
        }
        if (state.smokeActive !== undefined) {
            this.#writer.write(exports.SIGNAL_SMOKE_ACTIVE, {
                active: state.smokeActive,
                severity: 'critical',
                summary: exports.SMOKE_ACTIVE_SUMMARY,
            });
        }
    }
    /** Close the store and stop the grace timer. Does not clear any signal. */
    close() {
        if (this.#isClosed) {
            return;
        }
        this.#isClosed = true;
        this.#clearOfflineTimer();
        this.#writer.close();
    }
    #armOfflineGrace() {
        if (this.#offlineTimer !== null || this.#isCloudOfflineConfirmed) {
            return;
        }
        this.#offlineTimer = setTimeout(() => {
            this.#offlineTimer = null;
            if (this.#isClosed) {
                return;
            }
            this.#isCloudOfflineConfirmed = true;
            this.#writeCloud();
        }, this.#graceMs);
        this.#offlineTimer.unref?.();
    }
    #clearOfflineTimer() {
        if (this.#offlineTimer !== null) {
            clearTimeout(this.#offlineTimer);
            this.#offlineTimer = null;
        }
    }
    #writeAuth(active, failure) {
        this.#writer.write(exports.SIGNAL_AUTH_FAILED, {
            active,
            severity: 'error',
            summary: failure === 'login-form' ? exports.AUTH_LOGIN_FORM_SUMMARY : exports.AUTH_REJECTED_SUMMARY,
        });
    }
    #writeCloud() {
        this.#writer.write(exports.SIGNAL_CLOUD_OFFLINE, {
            active: this.#isCloudOfflineConfirmed && !this.#isAuthRejected,
            severity: 'error',
            summary: exports.CLOUD_OFFLINE_SUMMARY,
        });
    }
}
exports.AlarmComSignals = AlarmComSignals;
/** Build the signals for this plugin, backed by the homebridge-pagerduty store. */
function createAlarmComSignals(options) {
    return new AlarmComSignals(new pagerduty_signals_1.PagerDutySignals(options));
}
//# sourceMappingURL=alarmcom-signals.js.map