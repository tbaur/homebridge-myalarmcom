"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Alarm.com wire protocol: JSON:API envelopes and device state enums.
 *
 * Values are marked verified only where a live account actually produced them.
 * Anything inferred says so, because a confidently wrong constant in a security
 * plugin is worse than an acknowledged gap.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArmingModifier = exports.PartitionState = exports.OpenClosedStatus = exports.SensorState = exports.SensorDeviceType = exports.ResourceType = void 0;
exports.readSensorState = readSensorState;
exports.supportsNightArming = supportsNightArming;
exports.acceptsArmingModifier = acceptsArmingModifier;
/** Resource `type` discriminators returned by Alarm.com. */
var ResourceType;
(function (ResourceType) {
    ResourceType["PARTITION"] = "devices/partition";
    ResourceType["SENSOR"] = "devices/sensor";
})(ResourceType || (exports.ResourceType = ResourceType = {}));
// ---------------------------------------------------------------------------
// Sensors
// ---------------------------------------------------------------------------
/**
 * Sensor hardware category, from a sensor's `deviceType` attribute.
 *
 * Verified: all three appear on live hardware. Alarm.com supports more
 * categories (CO, water, glass break, panic); they are omitted rather than
 * guessed, and unrecognised types are skipped with a warning.
 */
var SensorDeviceType;
(function (SensorDeviceType) {
    SensorDeviceType[SensorDeviceType["CONTACT"] = 1] = "CONTACT";
    SensorDeviceType[SensorDeviceType["MOTION"] = 2] = "MOTION";
    SensorDeviceType[SensorDeviceType["SMOKE"] = 5] = "SMOKE";
})(SensorDeviceType || (exports.SensorDeviceType = SensorDeviceType = {}));
/**
 * Raw sensor `state`. Shared across every sensor category.
 *
 * The numeric meaning is uniform, but Alarm.com renders it per device type:
 * state 1 displays as "Closed" on a contact sensor and "Not Reset" on a smoke
 * detector. Only the label is device-specific; the semantics are not.
 *
 * Verified on live hardware: CLOSED, OPEN, IDLE, ACTIVE.
 * Inferred: UNKNOWN, DRY, WET (no such hardware on the test account).
 */
var SensorState;
(function (SensorState) {
    SensorState[SensorState["UNKNOWN"] = 0] = "UNKNOWN";
    SensorState[SensorState["CLOSED"] = 1] = "CLOSED";
    SensorState[SensorState["OPEN"] = 2] = "OPEN";
    SensorState[SensorState["IDLE"] = 3] = "IDLE";
    SensorState[SensorState["ACTIVE"] = 4] = "ACTIVE";
    SensorState[SensorState["DRY"] = 5] = "DRY";
    SensorState[SensorState["WET"] = 6] = "WET";
})(SensorState || (exports.SensorState = SensorState = {}));
/**
 * Normalised open/closed reading, from `openClosedStatus`.
 *
 * This is the most useful field Alarm.com returns and no public client uses it.
 * It collapses every sensor category onto one scale: across all 19 sensors on
 * the test account, every resting state reported 2 and every tripped state
 * reported 3, regardless of whether the sensor was a contact, motion, or smoke
 * device. It is the cross-check that catches a `state` value this plugin has
 * never seen before.
 */
var OpenClosedStatus;
(function (OpenClosedStatus) {
    OpenClosedStatus[OpenClosedStatus["UNKNOWN"] = 0] = "UNKNOWN";
    OpenClosedStatus[OpenClosedStatus["CLOSED"] = 2] = "CLOSED";
    OpenClosedStatus[OpenClosedStatus["OPEN"] = 3] = "OPEN";
})(OpenClosedStatus || (exports.OpenClosedStatus = OpenClosedStatus = {}));
/** Sensor `state` values that represent a tripped sensor. */
const TRIGGERED_SENSOR_STATES = new Set([
    SensorState.OPEN,
    SensorState.ACTIVE,
    SensorState.WET,
]);
/** Sensor `state` values that represent a sensor at rest. */
const RESTING_SENSOR_STATES = new Set([
    SensorState.CLOSED,
    SensorState.IDLE,
    SensorState.DRY,
]);
/** Human-readable labels per device type, matching Alarm.com's own UI text. */
const STATE_LABELS = {
    [SensorDeviceType.CONTACT]: {
        [SensorState.CLOSED]: 'Closed',
        [SensorState.OPEN]: 'Open',
    },
    [SensorDeviceType.MOTION]: {
        [SensorState.IDLE]: 'Idle',
        [SensorState.ACTIVE]: 'Activated',
    },
    [SensorDeviceType.SMOKE]: {
        // Alarm.com's wording for a smoke detector at rest. Not a fault condition:
        // it reported openClosedStatus=CLOSED alongside this state.
        [SensorState.CLOSED]: 'Not Reset',
        [SensorState.ACTIVE]: 'Activated',
    },
};
/**
 * Resolve a sensor's raw reading.
 *
 * `state` is authoritative when recognised, with `openClosedStatus` used to
 * cover states this plugin has not seen. Disagreement is surfaced via
 * `isAmbiguous` rather than silently resolved, so the platform can log it
 * instead of guessing wrong in either direction.
 */
function readSensorState(deviceType, state, openClosedStatus) {
    const label = STATE_LABELS[deviceType]?.[state]
        ?? SensorState[state]
        ?? 'Unknown';
    const isStateTriggered = TRIGGERED_SENSOR_STATES.has(state);
    const isStateResting = RESTING_SENSOR_STATES.has(state);
    const isStateKnown = isStateTriggered || isStateResting;
    if (openClosedStatus === undefined || openClosedStatus === OpenClosedStatus.UNKNOWN) {
        return { label, isTriggered: isStateTriggered, isAmbiguous: !isStateKnown };
    }
    const isOpenTriggered = openClosedStatus === OpenClosedStatus.OPEN;
    // Unrecognised state: fall back to the normalised reading rather than
    // reporting a tripped smoke detector as safe.
    if (!isStateKnown) {
        return { label, isTriggered: isOpenTriggered, isAmbiguous: true };
    }
    return {
        label,
        isTriggered: isStateTriggered,
        isAmbiguous: isStateTriggered !== isOpenTriggered,
    };
}
// ---------------------------------------------------------------------------
// Partitions
// ---------------------------------------------------------------------------
/**
 * Security panel arming state.
 *
 * Verified: DISARMED. The test account is provisioned read-only and never left
 * that state, so the armed values are inferred.
 */
var PartitionState;
(function (PartitionState) {
    PartitionState[PartitionState["UNKNOWN"] = 0] = "UNKNOWN";
    PartitionState[PartitionState["DISARMED"] = 1] = "DISARMED";
    PartitionState[PartitionState["ARMED_STAY"] = 2] = "ARMED_STAY";
    PartitionState[PartitionState["ARMED_AWAY"] = 3] = "ARMED_AWAY";
    PartitionState[PartitionState["ARMED_NIGHT"] = 4] = "ARMED_NIGHT";
})(PartitionState || (exports.PartitionState = PartitionState = {}));
/**
 * Modifier codes a panel may accept when arming.
 *
 * These appear as bare integers inside `extendedArmingOptions`, keyed by arming
 * mode. The test panel advertised BYPASS_SENSORS and SELECTIVELY_BYPASS_SENSORS
 * for both Stay and Away, plus NO_ENTRY_DELAY for Stay only. Notably it did
 * *not* advertise SILENT_ARMING for any mode.
 */
var ArmingModifier;
(function (ArmingModifier) {
    ArmingModifier[ArmingModifier["BYPASS_SENSORS"] = 0] = "BYPASS_SENSORS";
    ArmingModifier[ArmingModifier["NO_ENTRY_DELAY"] = 1] = "NO_ENTRY_DELAY";
    ArmingModifier[ArmingModifier["SILENT_ARMING"] = 2] = "SILENT_ARMING";
    ArmingModifier[ArmingModifier["NIGHT_ARMING"] = 3] = "NIGHT_ARMING";
    ArmingModifier[ArmingModifier["SELECTIVELY_BYPASS_SENSORS"] = 4] = "SELECTIVELY_BYPASS_SENSORS";
    ArmingModifier[ArmingModifier["FORCE_ARM"] = 5] = "FORCE_ARM";
})(ArmingModifier || (exports.ArmingModifier = ArmingModifier = {}));
/**
 * Whether the panel offers night arming.
 *
 * Alarm.com signals this by the presence of an `ArmedNight` entry rather than
 * by a boolean. The test panel omits the key entirely, so night arming is
 * withheld from HomeKit instead of being offered and failing at the panel.
 * Do not confuse this with `supportsNightArmingSchedules`, which concerns
 * scheduling and is true even here.
 */
function supportsNightArming(attributes) {
    const nightOptions = attributes.extendedArmingOptions?.ArmedNight;
    return Array.isArray(nightOptions);
}
/** Whether a panel accepts a given modifier for a given arming mode. */
function acceptsArmingModifier(attributes, mode, modifier) {
    return attributes.extendedArmingOptions?.[mode]?.includes(modifier) ?? false;
}
//# sourceMappingURL=alarm.js.map