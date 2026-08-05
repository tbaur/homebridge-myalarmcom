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

// ---------------------------------------------------------------------------
// JSON:API envelopes
// ---------------------------------------------------------------------------

/** A JSON:API resource linkage: a type/id pair pointing at another resource. */
export interface ResourceIdentifier {
  type: string
  id: string
}

/** A JSON:API relationship, which may hold one linkage or many. */
export interface Relationship {
  data?: ResourceIdentifier | ResourceIdentifier[]
  meta?: Record<string, unknown>
}

/** A JSON:API resource object with typed attributes. */
export interface Resource<TAttributes> {
  id: string
  type: string
  attributes: TAttributes
  relationships?: Record<string, Relationship>
}

/** A JSON:API response whose primary data is a single resource. */
export interface SingleResponse<TAttributes> {
  data: Resource<TAttributes>
  included?: Resource<unknown>[]
}

/** A JSON:API response whose primary data is a collection. */
export interface CollectionResponse<TAttributes> {
  data: Resource<TAttributes>[]
  included?: Resource<unknown>[]
}

/** Credentials for the push event stream. */
export interface EventStreamToken {
  token: string
  /** Endpoint reported by Alarm.com, when it supplies one. */
  endpoint?: string
}

// ---------------------------------------------------------------------------
// Sensors
// ---------------------------------------------------------------------------

/**
 * A sensor mapped onto the HomeKit service that should represent it.
 *
 * Declared here rather than beside the mapping functions so the event decoder
 * can name a device category without `types/` depending on `utils/`.
 */
export type SensorServiceKind = 'contact' | 'motion' | 'smoke'

/**
 * Sensor hardware category, from a sensor's `deviceType` attribute.
 *
 * Verified: all three appear on live hardware. Alarm.com supports more
 * categories (CO, water, glass break, panic); they are omitted rather than
 * guessed, and unrecognised types are skipped with a warning.
 */
export enum SensorDeviceType {
  CONTACT = 1,
  MOTION = 2,
  SMOKE = 5,
}

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
export enum SensorState {
  UNKNOWN = 0,
  CLOSED = 1,
  OPEN = 2,
  IDLE = 3,
  ACTIVE = 4,
  DRY = 5,
  WET = 6,
}

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
export enum OpenClosedStatus {
  UNKNOWN = 0,
  CLOSED = 2,
  OPEN = 3,
}

/** Sensor `state` values that represent a tripped sensor. */
const TRIGGERED_SENSOR_STATES: ReadonlySet<number> = new Set([
  SensorState.OPEN,
  SensorState.ACTIVE,
  SensorState.WET,
])

/** Sensor `state` values that represent a sensor at rest. */
const RESTING_SENSOR_STATES: ReadonlySet<number> = new Set([
  SensorState.CLOSED,
  SensorState.IDLE,
  SensorState.DRY,
])

/**
 * Human-readable labels per device type, matching Alarm.com's own UI text.
 *
 * A `Map` rather than an object literal because the keys come straight off an
 * unvalidated API response: an object literal inherits from `Object.prototype`,
 * so a `deviceType` of `"constructor"` would resolve to a function instead of
 * `undefined` and defeat every downstream guard.
 */
const STATE_LABELS: ReadonlyMap<number, ReadonlyMap<number, string>> = new Map([
  [SensorDeviceType.CONTACT, new Map([
    [SensorState.CLOSED, 'Closed'],
    [SensorState.OPEN, 'Open'],
  ])],
  [SensorDeviceType.MOTION, new Map([
    [SensorState.IDLE, 'Idle'],
    [SensorState.ACTIVE, 'Activated'],
  ])],
  [SensorDeviceType.SMOKE, new Map([
    // Alarm.com's wording for a smoke detector at rest. Not a fault condition:
    // it reported openClosedStatus=CLOSED alongside this state.
    [SensorState.CLOSED, 'Not Reset'],
    [SensorState.ACTIVE, 'Activated'],
  ])],
])

/** A sensor reading resolved into something HomeKit can act on. */
export interface SensorReading {
  /** Text matching what Alarm.com's own app displays. */
  label: string
  /** Whether the sensor is tripped. */
  isTriggered: boolean
  /** True when `state` and `openClosedStatus` disagree, or `state` is unknown. */
  isAmbiguous: boolean
}

/**
 * Resolve a sensor's raw reading.
 *
 * `state` is authoritative when recognised, with `openClosedStatus` used to
 * cover states this plugin has not seen. Disagreement is surfaced via
 * `isAmbiguous` rather than silently resolved, so the platform can log it
 * instead of guessing wrong in either direction.
 *
 * Arguments are typed `unknown` because they come from an API response parsed
 * without validation; a non-numeric value resolves to an ambiguous "Unknown"
 * reading rather than indexing a table with whatever arrived.
 */
export function readSensorState(
  deviceType: unknown,
  state: unknown,
  openClosedStatus?: unknown,
): SensorReading {
  if (typeof state !== 'number') {
    return { label: 'Unknown', isTriggered: false, isAmbiguous: true }
  }

  const labels = typeof deviceType === 'number' ? STATE_LABELS.get(deviceType) : undefined
  const label = labels?.get(state) ?? SensorState[state] ?? 'Unknown'

  const isStateTriggered = TRIGGERED_SENSOR_STATES.has(state)
  const isStateResting = RESTING_SENSOR_STATES.has(state)
  const isStateKnown = isStateTriggered || isStateResting

  const openClosed = typeof openClosedStatus === 'number' ? openClosedStatus : undefined

  if (openClosed === undefined || openClosed === OpenClosedStatus.UNKNOWN) {
    return { label, isTriggered: isStateTriggered, isAmbiguous: !isStateKnown }
  }

  const isOpenTriggered = openClosed === OpenClosedStatus.OPEN

  // Unrecognised state: fall back to the normalised reading rather than
  // reporting a tripped smoke detector as safe.
  if (!isStateKnown) {
    return { label, isTriggered: isOpenTriggered, isAmbiguous: true }
  }

  return {
    label,
    isTriggered: isStateTriggered,
    isAmbiguous: isStateTriggered !== isOpenTriggered,
  }
}

/** Attributes returned on a sensor resource. */
export interface SensorAttributes {
  description: string
  deviceType: number
  state: number
  openClosedStatus?: number
  displayStateText?: string
  isMonitoringEnabled?: boolean
  isMalfunctioning?: boolean
  isBypassed?: boolean
  supportsBypass?: boolean
  /**
   * Battery level, or null on hardware that does not report one.
   *
   * Every sensor on the test account returned null for both battery fields.
   * There is no `lowBattery` or `criticalBattery` flag on this payload.
   */
  batteryLevelNull: number | null
  batteryLevelClassification: number | null
  macAddress?: string
  manufacturer?: string | null
}

// ---------------------------------------------------------------------------
// Partitions
// ---------------------------------------------------------------------------

/** Arming commands Alarm.com accepts on a partition. */
export type PartitionAction = 'armStay' | 'armAway' | 'disarm'

/**
 * Security panel arming state.
 *
 * Verified: DISARMED and ARMED_STAY, both observed live by arming and
 * disarming from the mobile app while watching the account. Inferred: UNKNOWN,
 * ARMED_AWAY, ARMED_NIGHT — the read-only test account cannot issue those
 * commands. See docs/PROTOCOL.md.
 */
export enum PartitionState {
  UNKNOWN = 0,
  DISARMED = 1,
  ARMED_STAY = 2,
  ARMED_AWAY = 3,
  ARMED_NIGHT = 4,
}

/**
 * Modifier codes a panel may accept when arming.
 *
 * These appear as bare integers inside `extendedArmingOptions`, keyed by arming
 * mode. The test panel advertised BYPASS_SENSORS and SELECTIVELY_BYPASS_SENSORS
 * for both Stay and Away, plus NO_ENTRY_DELAY for Stay only. Notably it did
 * *not* advertise SILENT_ARMING for any mode.
 */
export enum ArmingModifier {
  BYPASS_SENSORS = 0,
  NO_ENTRY_DELAY = 1,
  SILENT_ARMING = 2,
  NIGHT_ARMING = 3,
  SELECTIVELY_BYPASS_SENSORS = 4,
  FORCE_ARM = 5,
}

/** Keys Alarm.com uses for arming modes inside the extended-options maps. */
export type ArmingModeName = 'Disarmed' | 'ArmedStay' | 'ArmedAway' | 'ArmedNight'

/**
 * Attributes returned on a partition resource.
 *
 * `extendedArmingOptions` maps each mode to the modifiers it accepts.
 * `invalidExtendedArmingOptions` maps each mode to *combinations* that are
 * rejected, hence the nested arrays.
 */
export interface PartitionAttributes {
  description?: string
  partitionId: number
  state: number
  desiredState?: number
  /**
   * Whether the signed-in user may change the arming state.
   *
   * Alarm.com accounts can be provisioned read-only, and the test account is.
   * Reading this up front lets the plugin expose the panel honestly rather than
   * accepting arm requests that the service will reject.
   */
  hasPermissionToChangeState: boolean
  extendedArmingOptions?: Partial<Record<ArmingModeName, number[]>>
  invalidExtendedArmingOptions?: Partial<Record<ArmingModeName, number[][]>>
  /** Unrelated to whether night arming itself is available. */
  supportsNightArmingSchedules?: boolean
  /**
   * Whether the panel is currently in alarm.
   *
   * This is a separate flag from `state`, which continues to report the arming
   * mode while an alarm is sounding. A client that maps only `state` can never
   * show a triggered alarm at all.
   */
  hasActiveAlarm?: boolean
  isMalfunctioning?: boolean
  needsClearIssuesPrompt?: boolean
  hasOpenBypassableSensors?: boolean
  hasSensorInTroubleCondition?: boolean
}

/**
 * Whether the panel offers night arming.
 *
 * Alarm.com signals this by the presence of an `ArmedNight` entry rather than
 * by a boolean. The test panel omits the key entirely, so night arming is
 * withheld from HomeKit instead of being offered and failing at the panel.
 * Do not confuse this with `supportsNightArmingSchedules`, which concerns
 * scheduling and is true even here.
 */
export function supportsNightArming(attributes: PartitionAttributes): boolean {
  const nightOptions = attributes.extendedArmingOptions?.ArmedNight
  return Array.isArray(nightOptions)
}

/** Whether a panel accepts a given modifier for a given arming mode. */
export function acceptsArmingModifier(
  attributes: PartitionAttributes,
  mode: ArmingModeName,
  modifier: ArmingModifier,
): boolean {
  return attributes.extendedArmingOptions?.[mode]?.includes(modifier) ?? false
}
