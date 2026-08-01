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
const alarm_1 = require("../types/alarm");
const mappers_1 = require("../utils/mappers");
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
    /** Last logged displayed state; info logs only fire when this changes. */
    #lastLoggedState = null;
    constructor(platform, accessory, log) {
        this.#platform = platform;
        this.#accessory = accessory;
        this.#log = log;
        const { Service: HapService, Characteristic } = platform;
        this.#service = accessory.getService(HapService.SecuritySystem)
            ?? accessory.addService(HapService.SecuritySystem);
        this.#service.setCharacteristic(Characteristic.Name, accessory.context.displayName);
        this.#service
            .getCharacteristic(Characteristic.SecuritySystemCurrentState)
            .onGet(() => this.#currentState());
        this.#service
            .getCharacteristic(Characteristic.SecuritySystemTargetState)
            .onGet(() => this.#targetState ?? this.#currentState())
            .onSet((value) => this.#handleTargetState(value));
    }
    get deviceId() {
        return this.#accessory.context.deviceId;
    }
    #currentState() {
        if (!this.#attributes) {
            return mappers_1.HomeKitSecurityState.DISARMED;
        }
        return (0, mappers_1.toDisplayedSecurityState)(this.#attributes) ?? mappers_1.HomeKitSecurityState.DISARMED;
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
        const characteristic = this.#service.getCharacteristic(Characteristic.SecuritySystemTargetState);
        // An account without permission to arm gets a read-only tile rather than
        // controls that always fail. Being honest in the UI beats surfacing an
        // error after the user has already tried.
        //
        // The test matches the one guarding the write, deliberately: anything
        // other than a literal `true` refuses the command, so anything other than
        // a literal `true` must also present as read-only. Testing for `false`
        // here and `!== true` there is what would offer working-looking controls
        // that reject every press.
        if (!this.#canChangeState(attributes)) {
            characteristic.setProps({
                validValues,
                perms: ["pr" /* this.#platform.api.hap.Perms.PAIRED_READ */, "ev" /* this.#platform.api.hap.Perms.NOTIFY */],
            });
            return;
        }
        characteristic.setProps({ validValues });
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
    /** Push fresh partition attributes into HomeKit. */
    update(resource) {
        const attributes = resource.attributes;
        const isFirstUpdate = this.#attributes === null;
        this.#attributes = attributes;
        if (isFirstUpdate) {
            this.#applyValidTargetStates(attributes);
            if (!this.#canChangeState(attributes)) {
                this.#log.warn(`The Alarm.com account used cannot change the arming state of "${attributes.description ?? this.deviceId}".`);
            }
        }
        const { Characteristic } = this.#platform;
        const currentState = this.#currentState();
        this.#service.updateCharacteristic(Characteristic.SecuritySystemCurrentState, currentState);
        // Once the panel reaches the requested state, stop overriding the target.
        if (this.#targetState !== null && this.#targetState === currentState) {
            this.#targetState = null;
        }
        this.#service.updateCharacteristic(Characteristic.SecuritySystemTargetState, this.#targetState ?? currentState);
        this.#service.updateCharacteristic(Characteristic.StatusFault, attributes.isMalfunctioning === true
            ? Characteristic.StatusFault.GENERAL_FAULT
            : Characteristic.StatusFault.NO_FAULT);
        if (attributes.hasActiveAlarm === true) {
            this.#log.warn(`Alarm.com reports an active alarm on "${attributes.description ?? this.deviceId}"`);
        }
        const name = attributes.description ?? this.deviceId;
        if (this.#lastLoggedState !== null && this.#lastLoggedState !== currentState) {
            this.#log.info(`${name}: ${(0, mappers_1.toSecurityStateLabel)(currentState)}`);
        }
        else {
            this.#log.debug(`${name}: ${(0, mappers_1.toSecurityStateLabel)(currentState)}`);
        }
        this.#lastLoggedState = currentState;
    }
    /**
     * Send an arming change requested from HomeKit.
     *
     * Modifiers are only included when the panel advertises support for them,
     * because Alarm.com rejects the whole command otherwise rather than ignoring
     * the unsupported flag.
     */
    async #handleTargetState(value) {
        const attributes = this.#attributes;
        // Fail closed. Responses are parsed without runtime validation, so an
        // absent, null or renamed field arrives as `undefined` here. Testing for
        // literal `false` would let a read-only account silently regain the
        // ability to disarm a physical alarm the moment Alarm.com changed a name.
        // A partition with no reading yet is refused for the same reason: nobody
        // knows whether this account may disarm it.
        if (attributes === null || !this.#canChangeState(attributes)) {
            this.#log.error(new errors_1.ReadOnlyPartitionError(attributes?.description ?? this.deviceId).message);
            throw new this.#platform.api.hap.HapStatusError(-70401 /* HAPStatus.INSUFFICIENT_PRIVILEGES */);
        }
        const target = Number(value);
        const action = (0, mappers_1.toPartitionAction)(target);
        if (!action) {
            throw new this.#platform.api.hap.HapStatusError(-70410 /* HAPStatus.INVALID_VALUE_IN_REQUEST */);
        }
        this.#targetState = target;
        const isNightArm = target === mappers_1.HomeKitSecurityTarget.NIGHT_ARM;
        const options = {
            nightArming: isNightArm,
            // Ask the mode actually being requested whether it supports force arming.
            // Reading the flag off `ArmedStay` for every mode meant a panel offering
            // it only under `ArmedAway` never received it, and away arming failed
            // with open sensors that the Alarm.com app would have bypassed.
            forceBypass: (0, alarm_1.acceptsArmingModifier)(attributes, (0, mappers_1.armingModeFor)(target), alarm_1.ArmingModifier.FORCE_ARM)
                && attributes.hasOpenBypassableSensors === true,
        };
        try {
            const startedAt = Date.now();
            await this.#platform.client.commandPartition(this.deviceId, action, options);
            const latencyMs = Date.now() - startedAt;
            const name = attributes.description ?? this.deviceId;
            this.#log.info(`${name}: ${(0, mappers_1.toSecurityStateLabel)(target)} (Latency: ${latencyMs}ms)`);
            // Prefer the commanded state for change detection so the confirming poll
            // does not emit a second identical info line without latency.
            this.#lastLoggedState = target;
            this.#platform.recordCommand();
            // Arming takes 20-30 seconds to settle at the panel, so the confirming
            // read is left to the next poll or event rather than done inline.
            this.#platform.requestDeviceRefresh(this.deviceId);
        }
        catch (error) {
            this.#targetState = null;
            this.#log.error(`Failed to ${action} partition ${this.deviceId}: ${String(error)}`);
            throw new this.#platform.api.hap.HapStatusError(-70402 /* HAPStatus.SERVICE_COMMUNICATION_FAILURE */);
        }
    }
}
exports.PartitionAccessory = PartitionAccessory;
//# sourceMappingURL=partition.js.map