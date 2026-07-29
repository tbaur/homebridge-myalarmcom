/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Security panel accessory.
 */

import { HAPStatus, type CharacteristicValue, type PlatformAccessory, type Service } from 'homebridge'
import { ReadOnlyPartitionError } from '../errors'
import {
  ArmingModifier,
  acceptsArmingModifier,
  supportsNightArming,
  type PartitionAttributes,
  type Resource,
} from '../types/alarm'
import type { Logger } from '../utils/logger'
import {
  HomeKitSecurityState,
  HomeKitSecurityTarget,
  armingModeFor,
  toDisplayedSecurityState,
  toPartitionAction,
} from '../utils/mappers'
import type { MyAlarmComPlatform } from '../platform'

/** What the platform stores on a partition accessory between restarts. */
export interface PartitionAccessoryContext {
  deviceId: string
  kind: 'partition'
  displayName: string
}

/** A HomeKit security system backed by one Alarm.com partition. */
export class PartitionAccessory {
  readonly #platform: MyAlarmComPlatform
  readonly #accessory: PlatformAccessory
  readonly #log: Logger
  readonly #service: Service

  /** Latest attributes seen, so characteristic reads never hit the network. */
  #attributes: PartitionAttributes | null = null
  /** What HomeKit last asked for, held until Alarm.com confirms the change. */
  #targetState: number | null = null

  constructor(
    platform: MyAlarmComPlatform,
    accessory: PlatformAccessory,
    log: Logger,
  ) {
    this.#platform = platform
    this.#accessory = accessory
    this.#log = log

    const { Service: HapService, Characteristic } = platform
    this.#service = accessory.getService(HapService.SecuritySystem)
      ?? accessory.addService(HapService.SecuritySystem)

    this.#service.setCharacteristic(
      Characteristic.Name,
      (accessory.context as PartitionAccessoryContext).displayName,
    )

    this.#service
      .getCharacteristic(Characteristic.SecuritySystemCurrentState)
      .onGet(() => this.#currentState())

    this.#service
      .getCharacteristic(Characteristic.SecuritySystemTargetState)
      .onGet(() => this.#targetState ?? this.#currentState())
      .onSet((value) => this.#handleTargetState(value))
  }

  get deviceId(): string {
    return (this.#accessory.context as PartitionAccessoryContext).deviceId
  }

  #currentState(): number {
    if (!this.#attributes) {
      return HomeKitSecurityState.DISARMED
    }
    return toDisplayedSecurityState(this.#attributes) ?? HomeKitSecurityState.DISARMED
  }

  /**
   * Restrict the modes HomeKit offers to those the panel actually accepts.
   *
   * Alarm.com signals night arming by the presence of an `ArmedNight` entry in
   * its extended arming options. Offering the mode when the panel lacks it
   * produces a command the panel rejects, which the user experiences as the
   * Home app silently snapping back.
   */
  #applyValidTargetStates(attributes: PartitionAttributes): void {
    const { Characteristic } = this.#platform

    const validValues = [
      HomeKitSecurityTarget.STAY_ARM,
      HomeKitSecurityTarget.AWAY_ARM,
      HomeKitSecurityTarget.DISARM,
    ]

    if (supportsNightArming(attributes)) {
      validValues.push(HomeKitSecurityTarget.NIGHT_ARM)
    }

    const characteristic = this.#service.getCharacteristic(
      Characteristic.SecuritySystemTargetState,
    )

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
        perms: [this.#platform.api.hap.Perms.PAIRED_READ, this.#platform.api.hap.Perms.NOTIFY],
      })
      return
    }

    characteristic.setProps({ validValues })
  }

  /**
   * Whether this account may arm or disarm the panel.
   *
   * Fails closed. Responses are parsed without runtime validation, so an
   * absent, null or renamed field arrives as `undefined`, and the safe answer
   * to "may this account disarm a physical alarm?" when nobody knows is no.
   */
  #canChangeState(attributes: PartitionAttributes): boolean {
    return attributes.hasPermissionToChangeState === true
  }

  /** Push fresh partition attributes into HomeKit. */
  update(resource: Resource<PartitionAttributes>): void {
    const attributes = resource.attributes
    const isFirstUpdate = this.#attributes === null
    this.#attributes = attributes

    if (isFirstUpdate) {
      this.#applyValidTargetStates(attributes)

      if (!this.#canChangeState(attributes)) {
        this.#log.warn(
          `The Alarm.com account cannot change the arming state of "${attributes.description ?? this.deviceId}". It is exposed to HomeKit as read-only.`,
        )
      }
    }

    const { Characteristic } = this.#platform
    const currentState = this.#currentState()

    this.#service.updateCharacteristic(
      Characteristic.SecuritySystemCurrentState,
      currentState,
    )

    // Once the panel reaches the requested state, stop overriding the target.
    if (this.#targetState !== null && this.#targetState === currentState) {
      this.#targetState = null
    }

    this.#service.updateCharacteristic(
      Characteristic.SecuritySystemTargetState,
      this.#targetState ?? currentState,
    )

    this.#service.updateCharacteristic(
      Characteristic.StatusFault,
      attributes.isMalfunctioning === true
        ? Characteristic.StatusFault.GENERAL_FAULT
        : Characteristic.StatusFault.NO_FAULT,
    )

    if (attributes.hasActiveAlarm === true) {
      this.#log.warn(`Alarm.com reports an active alarm on "${attributes.description ?? this.deviceId}"`)
    }
  }

  /**
   * Send an arming change requested from HomeKit.
   *
   * Modifiers are only included when the panel advertises support for them,
   * because Alarm.com rejects the whole command otherwise rather than ignoring
   * the unsupported flag.
   */
  async #handleTargetState(value: CharacteristicValue): Promise<void> {
    const attributes = this.#attributes

    // Fail closed. Responses are parsed without runtime validation, so an
    // absent, null or renamed field arrives as `undefined` here. Testing for
    // literal `false` would let a read-only account silently regain the
    // ability to disarm a physical alarm the moment Alarm.com changed a name.
    // A partition with no reading yet is refused for the same reason: nobody
    // knows whether this account may disarm it.
    if (attributes === null || !this.#canChangeState(attributes)) {
      this.#log.error(new ReadOnlyPartitionError(attributes?.description ?? this.deviceId).message)
      throw new this.#platform.api.hap.HapStatusError(HAPStatus.INSUFFICIENT_PRIVILEGES)
    }

    const target = Number(value)
    const action = toPartitionAction(target)

    if (!action) {
      throw new this.#platform.api.hap.HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST)
    }

    this.#targetState = target

    const isNightArm = target === HomeKitSecurityTarget.NIGHT_ARM
    const options = {
      nightArming: isNightArm,
      // Ask the mode actually being requested whether it supports force arming.
      // Reading the flag off `ArmedStay` for every mode meant a panel offering
      // it only under `ArmedAway` never received it, and away arming failed
      // with open sensors that the Alarm.com app would have bypassed.
      forceBypass: acceptsArmingModifier(attributes, armingModeFor(target), ArmingModifier.FORCE_ARM)
        && attributes.hasOpenBypassableSensors === true,
    }

    try {
      await this.#platform.client.commandPartition(this.deviceId, action, options)
      this.#platform.recordCommand()
      // Arming takes 20-30 seconds to settle at the panel, so the confirming
      // read is left to the next poll or event rather than done inline.
      this.#platform.requestDeviceRefresh(this.deviceId)
    } catch (error) {
      this.#targetState = null
      this.#log.error(`Failed to ${action} partition ${this.deviceId}: ${String(error)}`)
      throw new this.#platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    }
  }
}
