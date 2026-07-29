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
import { PartitionState, type ArmingModeName, type PartitionAttributes, type SensorAttributes } from '../types/alarm';
/** Mirrors `Characteristic.SecuritySystemCurrentState`. */
export declare enum HomeKitSecurityState {
    STAY_ARM = 0,
    AWAY_ARM = 1,
    NIGHT_ARM = 2,
    DISARMED = 3,
    ALARM_TRIGGERED = 4
}
/** Mirrors `Characteristic.SecuritySystemTargetState`. */
export declare enum HomeKitSecurityTarget {
    STAY_ARM = 0,
    AWAY_ARM = 1,
    NIGHT_ARM = 2,
    DISARM = 3
}
/** Mirrors `Characteristic.ContactSensorState`. */
export declare enum HomeKitContactState {
    CONTACT_DETECTED = 0,
    CONTACT_NOT_DETECTED = 1
}
/** Mirrors `Characteristic.SmokeDetected`. */
export declare enum HomeKitSmokeState {
    SMOKE_NOT_DETECTED = 0,
    SMOKE_DETECTED = 1
}
/**
 * Map an Alarm.com partition state to a HomeKit security state.
 *
 * Returns `undefined` for states this plugin does not recognise, so callers can
 * leave the existing HomeKit value alone. Defaulting an unknown panel state to
 * "disarmed" would be actively dangerous: it would show a green, safe-looking
 * tile for a system whose real state we do not know.
 */
export declare function toHomeKitSecurityState(partitionState: number): HomeKitSecurityState | undefined;
/** Map a HomeKit target state to the Alarm.com state it requests. */
export declare function toPartitionState(target: number): PartitionState | undefined;
/** Map a HomeKit target state to the Alarm.com command verb. */
export declare function toPartitionAction(target: number): 'armStay' | 'armAway' | 'disarm' | undefined;
/**
 * Resolve which arming mode's capabilities govern a requested target state.
 *
 * Night arming is sent as a Stay command with a modifier, but the panel
 * advertises what it supports under a separate `ArmedNight` key, so the mode
 * asked about is not always the verb sent.
 */
export declare function armingModeFor(target: number): ArmingModeName;
/**
 * Resolve the HomeKit state to display for a partition.
 *
 * An active alarm outranks the arming mode. Alarm.com keeps reporting `state`
 * as "armed away" while the siren is going, so a client that maps `state` alone
 * shows a calm armed tile during a break-in. `hasActiveAlarm` is the flag that
 * distinguishes them.
 */
export declare function toDisplayedSecurityState(attributes: PartitionAttributes): HomeKitSecurityState | undefined;
/** A sensor mapped onto the HomeKit service that should represent it. */
export type SensorServiceKind = 'contact' | 'motion' | 'smoke';
/**
 * Choose the HomeKit service for a sensor.
 *
 * Returns `undefined` for device types this plugin does not handle, which the
 * platform reports and skips rather than guessing at.
 */
export declare function toSensorServiceKind(deviceType: number): SensorServiceKind | undefined;
/** A sensor's reading expressed for HomeKit. */
export interface MappedSensorState {
    kind: SensorServiceKind;
    /** Value for the service's primary characteristic. */
    value: HomeKitContactState | HomeKitSmokeState | boolean;
    /** Alarm.com's own wording, for logs. */
    label: string;
    /** Set when the underlying reading was not conclusive. */
    isAmbiguous: boolean;
}
/** The characteristic value representing a triggered or resting sensor. */
export type SensorCharacteristicValue = HomeKitContactState | HomeKitSmokeState | boolean;
/**
 * Express a triggered/at-rest reading as the value its service expects.
 *
 * Note the inversion on contact sensors: HomeKit's `CONTACT_DETECTED` means the
 * magnet is present, so a *triggered* (open) sensor maps to `CONTACT_NOT_DETECTED`.
 */
export declare function toCharacteristicValue(kind: SensorServiceKind, isTriggered: boolean): SensorCharacteristicValue;
/**
 * Map a sensor resource to its HomeKit characteristic value.
 *
 * Returns `undefined` for unsupported device types.
 */
export declare function toHomeKitSensorState(attributes: SensorAttributes): MappedSensorState | undefined;
//# sourceMappingURL=mappers.d.ts.map