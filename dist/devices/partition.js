"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Security panel accessory.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PartitionAccessory = void 0;
const errors_1 = require("../errors");
const settings_1 = require("../settings");
const alarm_1 = require("../types/alarm");
const change_log_1 = require("./change-log");
const status_fault_1 = require("./status-fault");
const mappers_1 = require("../utils/mappers");
const sanitizers_1 = require("../utils/sanitizers");
/** A HomeKit security system backed by one Alarm.com partition. */
class PartitionAccessory {
    #platform;
    #accessory;
    #log;
    #service;
    /** Latest attributes seen, so characteristic reads never hit the network. */
    #attributes = null;
    /** What HomeKit last asked for, held until Alarm.com confirms the change. */
    #targetState = null;
    /** Last target published, so an alarm does not have to invent one. */
    #lastShownTarget = undefined;
    /** When {@link #targetState} was set, so a never-confirmed target can expire. */
    #targetSetAt = 0;
    /** Reports a state at info only when it differs from the previous one. */
    #logChange;
    /** Whether an active alarm was already reported, so it is warned about once. */
    #hasReportedAlarm = false;
    /** Inputs behind the characteristic props, so they are only reapplied on change. */
    #propsSignature = null;
    constructor(platform, accessory, log) {
        this.#platform = platform;
        this.#accessory = accessory;
        this.#log = log;
        this.#logChange = (0, change_log_1.createChangeLogger)(log);
        const { Service: HapService, Characteristic } = platform;
        this.#service = accessory.getService(HapService.SecuritySystem)
            ?? accessory.addService(HapService.SecuritySystem);
        this.#service.setCharacteristic(Characteristic.Name, accessory.context.displayName);
        this.#service
            .getCharacteristic(Characteristic.SecuritySystemCurrentState)
            .onGet(() => this.#currentState());
        this.#service
            .getCharacteristic(Characteristic.SecuritySystemTargetState)
            .onGet(() => this.#targetToShow(this.#currentState()) ?? mappers_1.HomeKitSecurityTarget.DISARM)
            .onSet((value) => this.#handleTargetState(value));
    }
    get deviceId() {
        return this.#accessory.context.deviceId;
    }
    /**
     * Republish the name when Alarm.com reports a different one.
     *
     * The constructor sets it once, and the constructor does not re-run for an
     * existing handler — so a device renamed at the panel kept its old HomeKit
     * name until Homebridge restarted, even though the platform was already
     * writing the new one into the accessory context.
     */
    updateName(displayName) {
        const { Characteristic } = this.#platform;
        if (this.#service.getCharacteristic(Characteristic.Name).value !== displayName) {
            this.#service.updateCharacteristic(Characteristic.Name, displayName);
        }
    }
    /** The panel's name, falling back to its ID when Alarm.com omits one. */
    get #name() {
        return this.#attributes?.description ?? this.deviceId;
    }
    /**
     * The state to show, or `undefined` when the panel's state is unrecognised.
     *
     * Kept separate from the characteristic write so an unmappable state can
     * leave the previous value alone. HAP still needs *some* value before the
     * first reading, which is the only case that falls back to disarmed.
     */
    #displayedState() {
        if (!this.#attributes) {
            return undefined;
        }
        return (0, mappers_1.toDisplayedSecurityState)(this.#attributes);
    }
    #currentState() {
        return this.#displayedState() ?? mappers_1.HomeKitSecurityState.DISARMED;
    }
    /**
     * What to show as the *target* state, which HAP restricts to 0-3.
     *
     * `ALARM_TRIGGERED` (4) is a legal current state and an illegal target. Writing
     * it made HAP clamp silently to 3 — so during an alarm the tile read
     * "Triggered" while its control read "Disarm", and a characteristic warning was
     * emitted on every poll for the duration. During an alarm the panel is still
     * armed in whatever mode it was, so the last shown target is the honest answer.
     */
    #targetToShow(displayedState) {
        if (this.#targetState !== null) {
            return this.#targetState;
        }
        if (displayedState === mappers_1.HomeKitSecurityState.ALARM_TRIGGERED) {
            return this.#lastShownTarget;
        }
        return displayedState;
    }
    /**
     * Restrict the modes HomeKit offers to those the panel actually accepts.
     *
     * Alarm.com signals night arming by the presence of an `ArmedNight` entry in
     * its extended arming options. Offering the mode when the panel lacks it
     * produces a command the panel rejects, which the user experiences as the
     * Home app silently snapping back.
     */
    #applyValidTargetStates(attributes) {
        const { Characteristic } = this.#platform;
        const validValues = [
            mappers_1.HomeKitSecurityTarget.STAY_ARM,
            mappers_1.HomeKitSecurityTarget.AWAY_ARM,
            mappers_1.HomeKitSecurityTarget.DISARM,
        ];
        if ((0, alarm_1.supportsNightArming)(attributes)) {
            validValues.push(mappers_1.HomeKitSecurityTarget.NIGHT_ARM);
        }
        const { Perms } = this.#platform.api.hap;
        const readOnly = ["pr" /* Perms.PAIRED_READ */, "ev" /* Perms.NOTIFY */];
        // An account without permission to arm gets a read-only tile rather than
        // controls that always fail. The test matches the one guarding the write
        // deliberately: anything other than a literal `true` refuses the command,
        // so anything other than a literal `true` must also present as read-only.
        //
        // Both branches state the permissions. Omitting them on the writable branch
        // left a tile read-only for the life of the process once it had been set
        // that way, so an account later granted permission to arm never regained it.
        this.#service.getCharacteristic(Characteristic.SecuritySystemTargetState).setProps({
            validValues,
            perms: this.#canChangeState(attributes)
                ? [...readOnly, "pw" /* Perms.PAIRED_WRITE */]
                : readOnly,
        });
    }
    /**
     * Whether this account may arm or disarm the panel.
     *
     * Fails closed. Responses are parsed without runtime validation, so an
     * absent, null or renamed field arrives as `undefined`, and the safe answer
     * to "may this account disarm a physical alarm?" when nobody knows is no.
     */
    #canChangeState(attributes) {
        return attributes.hasPermissionToChangeState === true;
    }
    /**
     * Refresh the HomeKit characteristic properties when their inputs change.
     *
     * Computing them only on the first reading meant a panel that later gained
     * night arming, or an account that was granted permission to arm, kept the
     * first reading's properties for the life of the process.
     */
    #syncTargetStateProps(attributes) {
        const canChangeState = this.#canChangeState(attributes);
        const signature = `${String(canChangeState)}:${String((0, alarm_1.supportsNightArming)(attributes))}`;
        if (signature === this.#propsSignature) {
            return;
        }
        const isFirstApply = this.#propsSignature === null;
        this.#propsSignature = signature;
        this.#applyValidTargetStates(attributes);
        if (isFirstApply && !canChangeState) {
            this.#log.warn(`The Alarm.com account used cannot change the arming state of "${this.#name}".`);
        }
    }
    /** Push fresh partition attributes into HomeKit. */
    update(resource) {
        const attributes = resource.attributes;
        this.#attributes = attributes;
        this.#syncTargetStateProps(attributes);
        const { Characteristic } = this.#platform;
        const displayedState = this.#displayedState();
        // Reported before the unrecognised-state branch below, so an unmappable
        // reading cannot swallow the edge into or out of an active alarm.
        this.#reportAlarmState(attributes);
        if (displayedState === undefined) {
            // Never guess. Showing a green, safe-looking tile for a panel whose real
            // state is unknown is the one failure mode a security integration must
            // not have, so the previous value stands and the tile is flagged faulty.
            this.#log.warn(`"${this.#name}" reported an arming state this plugin does not recognise (${String(attributes.state)}); `
                + 'leaving the previous state in place and flagging a fault.');
            this.#service.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT);
            // Still expire a pending target. Otherwise a panel stuck on an unmapped
            // state leaves the Home app showing "Arming…" indefinitely.
            this.#expireUnconfirmedTarget();
            return;
        }
        this.#service.updateCharacteristic(Characteristic.SecuritySystemCurrentState, displayedState);
        this.#resolveTargetState(displayedState);
        const targetToShow = this.#targetToShow(displayedState);
        if (targetToShow !== undefined) {
            this.#lastShownTarget = targetToShow;
            this.#service.updateCharacteristic(Characteristic.SecuritySystemTargetState, targetToShow);
        }
        (0, status_fault_1.applyStatusFault)(this.#service, Characteristic, attributes.isMalfunctioning);
        this.#logChange(this.#name, (0, mappers_1.toSecurityStateLabel)(displayedState));
    }
    /**
     * Stop overriding the target once the panel confirms it, or gives up.
     *
     * The expiry matters because confirmation is not guaranteed: a night arm is
     * sent as a stay command, so the panel lands on a state that never equals the
     * requested target, and an arm the user aborts at the keypad never arrives at
     * all. Without it the Home app shows "Arming…" indefinitely.
     */
    #resolveTargetState(currentState) {
        if (this.#targetState === null) {
            return;
        }
        if (this.#targetState === currentState) {
            this.#targetState = null;
            return;
        }
        this.#expireUnconfirmedTarget(currentState);
    }
    /** Drop a pending target the panel has had long enough to confirm. */
    #expireUnconfirmedTarget(currentState) {
        if (this.#targetState === null || Date.now() - this.#targetSetAt < settings_1.PARTITION_TARGET_SETTLE_MS) {
            return;
        }
        const reached = currentState === undefined
            ? 'a state this plugin does not recognise'
            : (0, mappers_1.toSecurityStateLabel)(currentState);
        this.#log.info(`"${this.#name}" did not reach ${(0, mappers_1.toSecurityStateLabel)(this.#targetState)}; showing ${reached} instead.`);
        this.#targetState = null;
    }
    /** Warn on the edge into alarm, and say so plainly when it clears. */
    #reportAlarmState(attributes) {
        const hasActiveAlarm = attributes.hasActiveAlarm === true;
        if (hasActiveAlarm && !this.#hasReportedAlarm) {
            this.#log.warn(`Alarm.com reports an active alarm on "${this.#name}"`);
        }
        else if (!hasActiveAlarm && this.#hasReportedAlarm) {
            this.#log.info(`The alarm on "${this.#name}" has cleared`);
        }
        this.#hasReportedAlarm = hasActiveAlarm;
    }
    /**
     * Send an arming change requested from HomeKit.
     *
     * Modifiers are only included when the panel advertises support for them,
     * because Alarm.com rejects the whole command otherwise rather than ignoring
     * the unsupported flag.
     */
    async #handleTargetState(value) {
        const attributes = this.#assertCanCommand();
        const target = Number(value);
        const action = (0, mappers_1.toPartitionAction)(target);
        if (!action) {
            throw new this.#platform.api.hap.HapStatusError(-70410 /* HAPStatus.INVALID_VALUE_IN_REQUEST */);
        }
        this.#targetState = target;
        this.#targetSetAt = Date.now();
        await this.#sendCommand(action, target, buildCommandOptions(attributes, target));
    }
    /**
     * Refuse the command unless this account is known to be allowed to arm.
     *
     * Fails closed. Responses are parsed without runtime validation, so an
     * absent, null or renamed field arrives as `undefined` here. Testing for
     * literal `false` would let a read-only account silently regain the ability
     * to disarm a physical alarm the moment Alarm.com changed a name. A partition
     * with no reading yet is refused for the same reason: nobody knows whether
     * this account may disarm it.
     */
    #assertCanCommand() {
        const attributes = this.#attributes;
        if (attributes === null || !this.#canChangeState(attributes)) {
            this.#log.error(new errors_1.ReadOnlyPartitionError(this.#name).message);
            throw new this.#platform.api.hap.HapStatusError(-70401 /* HAPStatus.INSUFFICIENT_PRIVILEGES */);
        }
        return attributes;
    }
    async #sendCommand(action, target, options) {
        const startedAt = Date.now();
        try {
            await this.#withCommandDeadline(this.#platform.client.commandPartition(this.deviceId, action, options));
            this.#log.info(`${this.#name}: ${(0, mappers_1.toSecurityStateLabel)(target)} (Latency: ${Date.now() - startedAt}ms)`);
            // Recorded through the change logger so the confirming poll, which will
            // report the same state, does not emit a second identical info line
            // without the latency figure.
            this.#logChange(this.#name, (0, mappers_1.toSecurityStateLabel)(target));
            this.#platform.recordCommand();
            // Arming takes 20-30 seconds to settle at the panel, so the confirming
            // read is left to the next poll or event rather than done inline.
            this.#platform.requestDeviceRefresh(this.deviceId);
        }
        catch (error) {
            this.#targetState = null;
            this.#log.error(`Failed to ${action} partition ${this.deviceId} after ${Date.now() - startedAt}ms: ${(0, sanitizers_1.sanitizeError)(error)}`);
            throw new this.#platform.api.hap.HapStatusError(error instanceof errors_1.TimeoutError
                ? -70408 /* HAPStatus.OPERATION_TIMED_OUT */
                : -70402 /* HAPStatus.SERVICE_COMMUNICATION_FAILURE */);
        }
    }
    /**
     * Bound the command so HAP does not cut the handler off mid-request.
     *
     * The command is left running when the deadline wins: it has already been
     * sent, so abandoning the *wait* is the only thing on offer. HomeKit is told
     * the operation timed out, and the confirming poll reports whatever the panel
     * actually did.
     */
    async #withCommandDeadline(command) {
        let timer;
        const deadline = new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new errors_1.TimeoutError(`Alarm.com did not answer the command within ${settings_1.PARTITION_COMMAND_DEADLINE_MS}ms`)), settings_1.PARTITION_COMMAND_DEADLINE_MS);
            timer.unref?.();
        });
        try {
            return await Promise.race([command, deadline]);
        }
        finally {
            clearTimeout(timer);
        }
    }
}
exports.PartitionAccessory = PartitionAccessory;
/**
 * Choose the modifiers to send with an arming command.
 *
 * Force-bypass is asked about for the mode actually being requested. Reading
 * the flag off `ArmedStay` for every mode meant a panel offering it only under
 * `ArmedAway` never received it, and away arming failed with open sensors that
 * the Alarm.com app would have bypassed.
 */
function buildCommandOptions(attributes, target) {
    return {
        nightArming: target === mappers_1.HomeKitSecurityTarget.NIGHT_ARM,
        forceBypass: (0, alarm_1.acceptsArmingModifier)(attributes, (0, mappers_1.armingModeFor)(target), alarm_1.ArmingModifier.FORCE_ARM)
            && attributes.hasOpenBypassableSensors === true,
    };
}
//# sourceMappingURL=partition.js.map