/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Contact, motion, and smoke sensor accessories.
 *
 * One class covers all three because they differ only in which HomeKit service
 * they publish and which characteristic carries the reading. The state
 * resolution behind them is identical.
 */

import type { Characteristic, PlatformAccessory, Service, WithUUID } from 'homebridge'
import { TRANSIENT_HINT_RESET_MS } from '../settings'
import type { Resource, SensorAttributes, SensorServiceKind } from '../types/alarm'
import type { Logger } from '../utils/logger'
import {
  toCharacteristicValue,
  toHomeKitSensorState,
  toImmediateSensorLabel,
} from '../utils/mappers'
import { createChangeLogger } from './change-log'
import { applyStatusFault } from './status-fault'
import type { MyAlarmComPlatform } from '../platform'

/** What the platform stores on a sensor accessory between restarts. */
export interface SensorAccessoryContext {
  deviceId: string
  kind: SensorServiceKind
  displayName: string
}

/** A HomeKit accessory backed by one Alarm.com sensor. */
export class SensorAccessory {
  readonly #platform: MyAlarmComPlatform
  readonly #accessory: PlatformAccessory
  readonly #log: Logger
  readonly #kind: SensorServiceKind
  readonly #service: Service
  /** Reports a reading at info only when it differs from the previous one. */
  readonly #logChange: (name: string, label: string) => void
  /** Latest name Alarm.com reported, so push and poll lines agree. */
  #name: string
  /** Whether an unresolvable reading has already been reported for this sensor. */
  #hasReportedUnsupportedType = false
  #hasReportedAmbiguity = false
  /** Clears a momentary event pulse if the confirming read never arrives. */
  #transientResetTimer: NodeJS.Timeout | null = null

  constructor(
    platform: MyAlarmComPlatform,
    accessory: PlatformAccessory,
    kind: SensorServiceKind,
    log: Logger,
  ) {
    this.#platform = platform
    this.#accessory = accessory
    this.#kind = kind
    this.#log = log
    this.#logChange = createChangeLogger(log)
    this.#name = (accessory.context as SensorAccessoryContext).displayName
    this.#service = this.#resolveService()
  }

  get deviceId(): string {
    return (this.#accessory.context as SensorAccessoryContext).deviceId
  }

  /** The device type established at discovery, which push frames misreport. */
  get kind(): SensorServiceKind {
    return this.#kind
  }

  /**
   * Republish the name when Alarm.com reports a different one.
   *
   * The constructor sets it once and does not re-run for an existing handler, so
   * a sensor renamed at the panel kept its old HomeKit name until Homebridge
   * restarted. Tracking it here also keeps the push and poll log lines using the
   * same name — they previously read from different sources and could disagree.
   */
  updateName(displayName: string): void {
    this.#name = displayName
    const { Characteristic } = this.#platform
    if (this.#service.getCharacteristic(Characteristic.Name).value !== displayName) {
      this.#service.updateCharacteristic(Characteristic.Name, displayName)
    }
  }

  /** Release any timer this accessory owns, so shutdown is clean. */
  dispose(): void {
    this.#clearTransientReset()
  }

  /** Find or create the HomeKit service matching this sensor's kind. */
  #resolveService(): Service {
    const { Service: HapService, Characteristic } = this.#platform
    const serviceType = this.#kind === 'contact'
      ? HapService.ContactSensor
      : this.#kind === 'motion'
        ? HapService.MotionSensor
        : HapService.SmokeSensor

    const service = this.#accessory.getService(serviceType)
      ?? this.#accessory.addService(serviceType)

    service.setCharacteristic(Characteristic.Name, this.#name)

    return service
  }

  /** The characteristic carrying this sensor's primary reading. */
  #primaryCharacteristic(): WithUUID<new () => Characteristic> {
    const { Characteristic } = this.#platform
    if (this.#kind === 'contact') {
      return Characteristic.ContactSensorState
    }
    if (this.#kind === 'motion') {
      return Characteristic.MotionDetected
    }
    return Characteristic.SmokeDetected
  }

  /**
   * Publish a state inferred from a push event, ahead of the confirming read.
   *
   * This exists so a door that is opened and shut within a second or two still
   * registers in HomeKit. The re-read that follows is authoritative and will
   * correct this value, so the cost of being wrong here is a brief flicker
   * rather than a persistently wrong state.
   *
   * @param isTransient The event already implies a return to rest, so the pulse
   *   is cleared on a timer if the confirming read never lands. Without that,
   *   a failed re-read leaves a door that has already shut showing open until
   *   the next poll — up to a day at the maximum poll interval.
   */
  applyImmediateState(isTriggered: boolean, isTransient = false): void {
    this.#clearTransientReset()

    this.#service.updateCharacteristic(
      this.#primaryCharacteristic(),
      toCharacteristicValue(this.#kind, isTriggered),
    )

    this.#logChange(this.#name, toImmediateSensorLabel(this.#kind, isTriggered))

    if (isTransient && isTriggered) {
      this.#transientResetTimer = setTimeout(() => {
        this.#transientResetTimer = null
        this.#log.debug(
          `${this.#name}: clearing a momentary event that was never confirmed by a read`,
        )
        this.applyImmediateState(false)
      }, TRANSIENT_HINT_RESET_MS)
      this.#transientResetTimer.unref?.()
    }
  }

  #clearTransientReset(): void {
    if (this.#transientResetTimer) {
      clearTimeout(this.#transientResetTimer)
      this.#transientResetTimer = null
    }
  }

  /**
   * Push a fresh Alarm.com reading into HomeKit.
   *
   * An unmappable device type leaves the previous value in place rather than
   * substituting a default, so a sensor never quietly reports "all clear"
   * because its type was unrecognised.
   */
  update(resource: Resource<SensorAttributes>): void {
    // An authoritative read supersedes any momentary event pulse.
    this.#clearTransientReset()

    const attributes = resource.attributes
    const name = this.#name
    const mapped = toHomeKitSensorState(attributes)

    if (!mapped) {
      // Warned once per process, not once per poll. This runs for every sensor
      // on every cycle, so an unconditional warning is 1,440 identical lines a
      // day at the minimum poll interval.
      if (!this.#hasReportedUnsupportedType) {
        this.#hasReportedUnsupportedType = true
        this.#log.warn(
          `Sensor "${name}" reported an unsupported device type ${String(attributes.deviceType)}; leaving its state unchanged.`,
        )
      }
      return
    }

    // The service was chosen from the device type at construction and does not
    // change afterwards. If Alarm.com reports a different type for this id — a
    // reassigned device — writing the new reading to the old service would put a
    // motion value on a contact characteristic. Leave the state alone instead.
    if (mapped.kind !== this.#kind) {
      if (!this.#hasReportedUnsupportedType) {
        this.#hasReportedUnsupportedType = true
        this.#log.warn(
          `Sensor "${name}" is now reporting as a ${mapped.kind} sensor but was published as ${this.#kind}; `
          + 'leaving its state unchanged. Restart Homebridge to republish it.',
        )
      }
      return
    }

    if (mapped.isAmbiguous && !this.#hasReportedAmbiguity) {
      this.#hasReportedAmbiguity = true
      this.#log.warn(
        `Sensor "${name}" reported state ${String(attributes.state)} with openClosedStatus ${String(attributes.openClosedStatus)}, which this plugin does not recognise as a matched pair. Treating it as "${mapped.label}"; please report this.`,
      )
    } else if (!mapped.isAmbiguous) {
      this.#hasReportedAmbiguity = false
    }

    this.#service.updateCharacteristic(this.#primaryCharacteristic(), mapped.value)

    const { Characteristic } = this.#platform

    // StatusActive is how HomeKit expresses "this sensor exists but is not
    // currently supervised", which is exactly what disabled monitoring means.
    this.#service.updateCharacteristic(
      Characteristic.StatusActive,
      attributes.isMonitoringEnabled !== false,
    )

    applyStatusFault(this.#service, Characteristic, attributes.isMalfunctioning)

    this.#logChange(name, mapped.label)
  }
}
