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
import type { Resource, SensorAttributes } from '../types/alarm'
import type { Logger } from '../utils/logger'
import {
  toCharacteristicValue,
  toHomeKitSensorState,
  type SensorServiceKind,
} from '../utils/mappers'
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
    this.#service = this.#resolveService()
  }

  get deviceId(): string {
    return (this.#accessory.context as SensorAccessoryContext).deviceId
  }

  /** The device type established at discovery, which push frames misreport. */
  get kind(): SensorServiceKind {
    return this.#kind
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

    service.setCharacteristic(
      Characteristic.Name,
      (this.#accessory.context as SensorAccessoryContext).displayName,
    )

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
   */
  applyImmediateState(isTriggered: boolean): void {
    this.#service.updateCharacteristic(
      this.#primaryCharacteristic(),
      toCharacteristicValue(this.#kind, isTriggered),
    )
    this.#log.debug(`${this.deviceId} pushed to ${isTriggered ? 'triggered' : 'at rest'} by an event`)
  }

  /**
   * Push a fresh Alarm.com reading into HomeKit.
   *
   * An unmappable reading leaves the previous value in place rather than
   * substituting a default, so a sensor never quietly reports "all clear"
   * because its state was unrecognised.
   */
  update(resource: Resource<SensorAttributes>): void {
    const attributes = resource.attributes
    const mapped = toHomeKitSensorState(attributes)

    if (!mapped) {
      this.#log.warn(
        `Sensor "${attributes.description}" reported an unsupported device type ${attributes.deviceType}; leaving its state unchanged.`,
      )
      return
    }

    if (mapped.isAmbiguous) {
      this.#log.warn(
        `Sensor "${attributes.description}" reported state ${attributes.state} with openClosedStatus ${String(attributes.openClosedStatus)}, which this plugin does not recognise as a matched pair. Treating it as "${mapped.label}"; please report this.`,
      )
    }

    this.#service.updateCharacteristic(this.#primaryCharacteristic(), mapped.value)

    const { Characteristic } = this.#platform

    // StatusActive is how HomeKit expresses "this sensor exists but is not
    // currently supervised", which is exactly what disabled monitoring means.
    this.#service.updateCharacteristic(
      Characteristic.StatusActive,
      attributes.isMonitoringEnabled !== false,
    )

    this.#service.updateCharacteristic(
      Characteristic.StatusFault,
      attributes.isMalfunctioning === true
        ? Characteristic.StatusFault.GENERAL_FAULT
        : Characteristic.StatusFault.NO_FAULT,
    )

    this.#log.debug(`${attributes.description} is ${mapped.label}`)
  }
}
