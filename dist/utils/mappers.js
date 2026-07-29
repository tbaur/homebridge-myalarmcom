"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Translation between Alarm.com state and HomeKit characteristics.
 *
 * These functions are deliberately free of any HAP import so they can be tested
 * against captured fixtures without constructing a Homebridge environment. The
 * numeric constants below mirror HAP's own values; a unit test asserts they
 * still match at runtime, so the decoupling cannot silently drift.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HomeKitSmokeState = exports.HomeKitContactState = exports.HomeKitSecurityTarget = exports.HomeKitSecurityState = void 0;
exports.toHomeKitSecurityState = toHomeKitSecurityState;
exports.toPartitionState = toPartitionState;
exports.toPartitionAction = toPartitionAction;
exports.armingModeFor = armingModeFor;
exports.toDisplayedSecurityState = toDisplayedSecurityState;
exports.toSecurityStateLabel = toSecurityStateLabel;
exports.toImmediateSensorLabel = toImmediateSensorLabel;
exports.toSensorServiceKind = toSensorServiceKind;
exports.toCharacteristicValue = toCharacteristicValue;
exports.toHomeKitSensorState = toHomeKitSensorState;
const alarm_1 = require("../types/alarm");
/** Mirrors `Characteristic.SecuritySystemCurrentState`. */
var HomeKitSecurityState;
(function (HomeKitSecurityState) {
    HomeKitSecurityState[HomeKitSecurityState["STAY_ARM"] = 0] = "STAY_ARM";
    HomeKitSecurityState[HomeKitSecurityState["AWAY_ARM"] = 1] = "AWAY_ARM";
    HomeKitSecurityState[HomeKitSecurityState["NIGHT_ARM"] = 2] = "NIGHT_ARM";
    HomeKitSecurityState[HomeKitSecurityState["DISARMED"] = 3] = "DISARMED";
    HomeKitSecurityState[HomeKitSecurityState["ALARM_TRIGGERED"] = 4] = "ALARM_TRIGGERED";
})(HomeKitSecurityState || (exports.HomeKitSecurityState = HomeKitSecurityState = {}));
/** Mirrors `Characteristic.SecuritySystemTargetState`. */
var HomeKitSecurityTarget;
(function (HomeKitSecurityTarget) {
    HomeKitSecurityTarget[HomeKitSecurityTarget["STAY_ARM"] = 0] = "STAY_ARM";
    HomeKitSecurityTarget[HomeKitSecurityTarget["AWAY_ARM"] = 1] = "AWAY_ARM";
    HomeKitSecurityTarget[HomeKitSecurityTarget["NIGHT_ARM"] = 2] = "NIGHT_ARM";
    HomeKitSecurityTarget[HomeKitSecurityTarget["DISARM"] = 3] = "DISARM";
})(HomeKitSecurityTarget || (exports.HomeKitSecurityTarget = HomeKitSecurityTarget = {}));
/** Mirrors `Characteristic.ContactSensorState`. */
var HomeKitContactState;
(function (HomeKitContactState) {
    HomeKitContactState[HomeKitContactState["CONTACT_DETECTED"] = 0] = "CONTACT_DETECTED";
    HomeKitContactState[HomeKitContactState["CONTACT_NOT_DETECTED"] = 1] = "CONTACT_NOT_DETECTED";
})(HomeKitContactState || (exports.HomeKitContactState = HomeKitContactState = {}));
/** Mirrors `Characteristic.SmokeDetected`. */
var HomeKitSmokeState;
(function (HomeKitSmokeState) {
    HomeKitSmokeState[HomeKitSmokeState["SMOKE_NOT_DETECTED"] = 0] = "SMOKE_NOT_DETECTED";
    HomeKitSmokeState[HomeKitSmokeState["SMOKE_DETECTED"] = 1] = "SMOKE_DETECTED";
})(HomeKitSmokeState || (exports.HomeKitSmokeState = HomeKitSmokeState = {}));
const PARTITION_TO_HOMEKIT = {
    [alarm_1.PartitionState.DISARMED]: HomeKitSecurityState.DISARMED,
    [alarm_1.PartitionState.ARMED_STAY]: HomeKitSecurityState.STAY_ARM,
    [alarm_1.PartitionState.ARMED_AWAY]: HomeKitSecurityState.AWAY_ARM,
    [alarm_1.PartitionState.ARMED_NIGHT]: HomeKitSecurityState.NIGHT_ARM,
};
const HOMEKIT_TARGET_TO_PARTITION = {
    [HomeKitSecurityTarget.STAY_ARM]: alarm_1.PartitionState.ARMED_STAY,
    [HomeKitSecurityTarget.AWAY_ARM]: alarm_1.PartitionState.ARMED_AWAY,
    [HomeKitSecurityTarget.NIGHT_ARM]: alarm_1.PartitionState.ARMED_NIGHT,
    [HomeKitSecurityTarget.DISARM]: alarm_1.PartitionState.DISARMED,
};
/**
 * Map an Alarm.com partition state to a HomeKit security state.
 *
 * Returns `undefined` for states this plugin does not recognise, so callers can
 * leave the existing HomeKit value alone. Defaulting an unknown panel state to
 * "disarmed" would be actively dangerous: it would show a green, safe-looking
 * tile for a system whose real state we do not know.
 */
function toHomeKitSecurityState(partitionState) {
    return PARTITION_TO_HOMEKIT[partitionState];
}
/** Map a HomeKit target state to the Alarm.com state it requests. */
function toPartitionState(target) {
    return HOMEKIT_TARGET_TO_PARTITION[target];
}
/** Map a HomeKit target state to the Alarm.com command verb. */
function toPartitionAction(target) {
    switch (target) {
        case HomeKitSecurityTarget.STAY_ARM:
            return 'armStay';
        case HomeKitSecurityTarget.AWAY_ARM:
            return 'armAway';
        // Night arming is a Stay command carrying the nightArming modifier rather
        // than a verb of its own.
        case HomeKitSecurityTarget.NIGHT_ARM:
            return 'armStay';
        case HomeKitSecurityTarget.DISARM:
            return 'disarm';
        default:
            return undefined;
    }
}
/**
 * Resolve which arming mode's capabilities govern a requested target state.
 *
 * Night arming is sent as a Stay command with a modifier, but the panel
 * advertises what it supports under a separate `ArmedNight` key, so the mode
 * asked about is not always the verb sent.
 */
function armingModeFor(target) {
    switch (target) {
        case HomeKitSecurityTarget.AWAY_ARM:
            return 'ArmedAway';
        case HomeKitSecurityTarget.NIGHT_ARM:
            return 'ArmedNight';
        case HomeKitSecurityTarget.DISARM:
            return 'Disarmed';
        default:
            return 'ArmedStay';
    }
}
/**
 * Resolve the HomeKit state to display for a partition.
 *
 * An active alarm outranks the arming mode. Alarm.com keeps reporting `state`
 * as "armed away" while the siren is going, so a client that maps `state` alone
 * shows a calm armed tile during a break-in. `hasActiveAlarm` is the flag that
 * distinguishes them.
 */
function toDisplayedSecurityState(attributes) {
    if (attributes.hasActiveAlarm === true) {
        return HomeKitSecurityState.ALARM_TRIGGERED;
    }
    return toHomeKitSecurityState(attributes.state);
}
/** Human-readable arming state for logs. */
function toSecurityStateLabel(state) {
    switch (state) {
        case HomeKitSecurityState.STAY_ARM:
            return 'Armed Stay';
        case HomeKitSecurityState.AWAY_ARM:
            return 'Armed Away';
        case HomeKitSecurityState.NIGHT_ARM:
            return 'Armed Night';
        case HomeKitSecurityState.DISARMED:
            return 'Disarmed';
        case HomeKitSecurityState.ALARM_TRIGGERED:
            return 'Alarm';
        default:
            return `State ${String(state)}`;
    }
}
/**
 * Label for an event-hinted sensor reading (before the confirming API read).
 *
 * Matches the Alarm.com wording used by {@link readSensorState} for the same
 * resting/triggered outcomes, so push and poll logs stay consistent.
 */
function toImmediateSensorLabel(kind, isTriggered) {
    switch (kind) {
        case 'contact':
            return isTriggered ? 'Open' : 'Closed';
        case 'motion':
            return isTriggered ? 'Activated' : 'Idle';
        case 'smoke':
            return isTriggered ? 'Activated' : 'Not Reset';
    }
}
const DEVICE_TYPE_TO_SERVICE = {
    [alarm_1.SensorDeviceType.CONTACT]: 'contact',
    [alarm_1.SensorDeviceType.MOTION]: 'motion',
    [alarm_1.SensorDeviceType.SMOKE]: 'smoke',
};
/**
 * Choose the HomeKit service for a sensor.
 *
 * Returns `undefined` for device types this plugin does not handle, which the
 * platform reports and skips rather than guessing at.
 */
function toSensorServiceKind(deviceType) {
    return DEVICE_TYPE_TO_SERVICE[deviceType];
}
/**
 * Express a triggered/at-rest reading as the value its service expects.
 *
 * Note the inversion on contact sensors: HomeKit's `CONTACT_DETECTED` means the
 * magnet is present, so a *triggered* (open) sensor maps to `CONTACT_NOT_DETECTED`.
 */
function toCharacteristicValue(kind, isTriggered) {
    switch (kind) {
        case 'contact':
            return isTriggered
                ? HomeKitContactState.CONTACT_NOT_DETECTED
                : HomeKitContactState.CONTACT_DETECTED;
        case 'smoke':
            return isTriggered
                ? HomeKitSmokeState.SMOKE_DETECTED
                : HomeKitSmokeState.SMOKE_NOT_DETECTED;
        case 'motion':
            return isTriggered;
    }
}
/**
 * Map a sensor resource to its HomeKit characteristic value.
 *
 * Returns `undefined` for unsupported device types.
 */
function toHomeKitSensorState(attributes) {
    const kind = toSensorServiceKind(attributes.deviceType);
    if (!kind) {
        return undefined;
    }
    const reading = (0, alarm_1.readSensorState)(attributes.deviceType, attributes.state, attributes.openClosedStatus);
    return {
        kind,
        value: toCharacteristicValue(kind, reading.isTriggered),
        label: reading.label,
        isAmbiguous: reading.isAmbiguous,
    };
}
//# sourceMappingURL=mappers.js.map