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

import {
  PartitionState,
  readSensorState,
  SensorDeviceType,
  type ArmingModeName,
  type PartitionAction,
  type PartitionAttributes,
  type SensorAttributes,
  type SensorServiceKind,
} from '../types/alarm'

export type { SensorServiceKind }

/** Mirrors `Characteristic.SecuritySystemCurrentState`. */
export enum HomeKitSecurityState {
  STAY_ARM = 0,
  AWAY_ARM = 1,
  NIGHT_ARM = 2,
  DISARMED = 3,
  ALARM_TRIGGERED = 4,
}

/** Mirrors `Characteristic.SecuritySystemTargetState`. */
export enum HomeKitSecurityTarget {
  STAY_ARM = 0,
  AWAY_ARM = 1,
  NIGHT_ARM = 2,
  DISARM = 3,
}

/** Mirrors `Characteristic.ContactSensorState`. */
export enum HomeKitContactState {
  CONTACT_DETECTED = 0,
  CONTACT_NOT_DETECTED = 1,
}

/** Mirrors `Characteristic.SmokeDetected`. */
export enum HomeKitSmokeState {
  SMOKE_NOT_DETECTED = 0,
  SMOKE_DETECTED = 1,
}

/**
 * A `Map`, not an object literal: the key is an unvalidated API value, and an
 * object literal would resolve `"constructor"` to a function rather than
 * `undefined`, quietly defeating the guard below.
 */
const PARTITION_TO_HOMEKIT: ReadonlyMap<number, HomeKitSecurityState> = new Map([
  [PartitionState.DISARMED, HomeKitSecurityState.DISARMED],
  [PartitionState.ARMED_STAY, HomeKitSecurityState.STAY_ARM],
  [PartitionState.ARMED_AWAY, HomeKitSecurityState.AWAY_ARM],
  [PartitionState.ARMED_NIGHT, HomeKitSecurityState.NIGHT_ARM],
])

/**
 * Map an Alarm.com partition state to a HomeKit security state.
 *
 * Returns `undefined` for states this plugin does not recognise, so callers can
 * leave the existing HomeKit value alone. Defaulting an unknown panel state to
 * "disarmed" would be actively dangerous: it would show a green, safe-looking
 * tile for a system whose real state we do not know.
 */
export function toHomeKitSecurityState(
  partitionState: unknown,
): HomeKitSecurityState | undefined {
  return typeof partitionState === 'number'
    ? PARTITION_TO_HOMEKIT.get(partitionState)
    : undefined
}

/** Map a HomeKit target state to the Alarm.com command verb. */
export function toPartitionAction(target: number): PartitionAction | undefined {
  switch (target) {
    case HomeKitSecurityTarget.STAY_ARM:
      return 'armStay'
    case HomeKitSecurityTarget.AWAY_ARM:
      return 'armAway'
    // Night arming is a Stay command carrying the nightArming modifier rather
    // than a verb of its own.
    case HomeKitSecurityTarget.NIGHT_ARM:
      return 'armStay'
    case HomeKitSecurityTarget.DISARM:
      return 'disarm'
    default:
      return undefined
  }
}

/**
 * Resolve which arming mode's capabilities govern a requested target state.
 *
 * Night arming is sent as a Stay command with a modifier, but the panel
 * advertises what it supports under a separate `ArmedNight` key, so the mode
 * asked about is not always the verb sent.
 */
export function armingModeFor(target: number): ArmingModeName {
  switch (target) {
    case HomeKitSecurityTarget.AWAY_ARM:
      return 'ArmedAway'
    case HomeKitSecurityTarget.NIGHT_ARM:
      return 'ArmedNight'
    case HomeKitSecurityTarget.DISARM:
      return 'Disarmed'
    default:
      return 'ArmedStay'
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
export function toDisplayedSecurityState(
  attributes: PartitionAttributes,
): HomeKitSecurityState | undefined {
  if (attributes.hasActiveAlarm === true) {
    return HomeKitSecurityState.ALARM_TRIGGERED
  }
  return toHomeKitSecurityState(attributes.state)
}

/**
 * Human-readable arming state for logs.
 *
 * Takes a plain `number` because callers hold HomeKit characteristic values,
 * which are numbers at runtime whatever the enum claims. The default branch is
 * the point: a value outside the enum must read as an obvious unknown rather
 * than being asserted into one of the five safe-sounding labels.
 */
export function toSecurityStateLabel(state: number): string {
  switch (state) {
    case HomeKitSecurityState.STAY_ARM:
      return 'Armed Stay'
    case HomeKitSecurityState.AWAY_ARM:
      return 'Armed Away'
    case HomeKitSecurityState.NIGHT_ARM:
      return 'Armed Night'
    case HomeKitSecurityState.DISARMED:
      return 'Disarmed'
    case HomeKitSecurityState.ALARM_TRIGGERED:
      return 'Alarm'
    default:
      return `State ${String(state)}`
  }
}

/**
 * Label for an event-hinted sensor reading (before the confirming API read).
 *
 * Matches the Alarm.com wording used by {@link readSensorState} for the same
 * resting/triggered outcomes, so push and poll logs stay consistent.
 */
export function toImmediateSensorLabel(kind: SensorServiceKind, isTriggered: boolean): string {
  switch (kind) {
    case 'contact':
      return isTriggered ? 'Open' : 'Closed'
    case 'motion':
      return isTriggered ? 'Activated' : 'Idle'
    case 'smoke':
      return isTriggered ? 'Activated' : 'Not Reset'
  }
}

/** See the note on {@link PARTITION_TO_HOMEKIT} for why this is a `Map`. */
const DEVICE_TYPE_TO_SERVICE: ReadonlyMap<number, SensorServiceKind> = new Map([
  [SensorDeviceType.CONTACT, 'contact' as const],
  [SensorDeviceType.MOTION, 'motion' as const],
  [SensorDeviceType.SMOKE, 'smoke' as const],
])

/**
 * Choose the HomeKit service for a sensor.
 *
 * Returns `undefined` for device types this plugin does not handle, which the
 * platform reports and skips rather than guessing at.
 */
export function toSensorServiceKind(deviceType: unknown): SensorServiceKind | undefined {
  return typeof deviceType === 'number'
    ? DEVICE_TYPE_TO_SERVICE.get(deviceType)
    : undefined
}

/** A sensor's reading expressed for HomeKit. */
export interface MappedSensorState {
  kind: SensorServiceKind
  /** Value for the service's primary characteristic. */
  value: HomeKitContactState | HomeKitSmokeState | boolean
  /** Alarm.com's own wording, for logs. */
  label: string
  /** Set when the underlying reading was not conclusive. */
  isAmbiguous: boolean
}

/** The characteristic value representing a triggered or resting sensor. */
export type SensorCharacteristicValue = HomeKitContactState | HomeKitSmokeState | boolean

/**
 * Express a triggered/at-rest reading as the value its service expects.
 *
 * Note the inversion on contact sensors: HomeKit's `CONTACT_DETECTED` means the
 * magnet is present, so a *triggered* (open) sensor maps to `CONTACT_NOT_DETECTED`.
 */
export function toCharacteristicValue(
  kind: SensorServiceKind,
  isTriggered: boolean,
): SensorCharacteristicValue {
  switch (kind) {
    case 'contact':
      return isTriggered
        ? HomeKitContactState.CONTACT_NOT_DETECTED
        : HomeKitContactState.CONTACT_DETECTED
    case 'smoke':
      return isTriggered
        ? HomeKitSmokeState.SMOKE_DETECTED
        : HomeKitSmokeState.SMOKE_NOT_DETECTED
    case 'motion':
      return isTriggered
  }
}

/**
 * Map a sensor resource to its HomeKit characteristic value.
 *
 * Returns `undefined` for unsupported device types.
 */
export function toHomeKitSensorState(
  attributes: SensorAttributes,
): MappedSensorState | undefined {
  const kind = toSensorServiceKind(attributes.deviceType)
  if (!kind) {
    return undefined
  }

  const reading = readSensorState(
    attributes.deviceType,
    attributes.state,
    attributes.openClosedStatus,
  )

  return {
    kind,
    value: toCharacteristicValue(kind, reading.isTriggered),
    label: reading.label,
    isAmbiguous: reading.isAmbiguous,
  }
}
