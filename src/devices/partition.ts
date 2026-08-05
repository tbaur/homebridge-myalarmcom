/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Security panel accessory.
 */

import { HAPStatus, type CharacteristicValue, type PlatformAccessory, type Service } from 'homebridge'
import { ReadOnlyPartitionError, TimeoutError } from '../errors'
import { PARTITION_COMMAND_DEADLINE_MS, PARTITION_TARGET_SETTLE_MS } from '../settings'
import {
  ArmingModifier,
  acceptsArmingModifier,
  supportsNightArming,
  type PartitionAttributes,
  type PartitionAction,
  type Resource,
} from '../types/alarm'
import type { Logger } from '../utils/logger'
import { createChangeLogger } from './change-log'
import { applyStatusFault } from './status-fault'
import {
  HomeKitSecurityState,
  HomeKitSecurityTarget,
  armingModeFor,
  toDisplayedSecurityState,
  toPartitionAction,
  toSecurityStateLabel,
} from '../utils/mappers'
import { sanitizeError } from '../utils/sanitizers'
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
  /** Last target published, so an alarm does not have to invent one. */
  #lastShownTarget: number | undefined = undefined
  /** When {@link #targetState} was set, so a never-confirmed target can expire. */
  #targetSetAt = 0
  /** Reports a state at info only when it differs from the previous one. */
  readonly #logChange: (name: string, label: string) => void
  /** Whether an active alarm was already reported, so it is warned about once. */
  #hasReportedAlarm = false
  /** Inputs behind the characteristic props, so they are only reapplied on change. */
  #propsSignature: string | null = null

  constructor(
    platform: MyAlarmComPlatform,
    accessory: PlatformAccessory,
    log: Logger,
  ) {
    this.#platform = platform
    this.#accessory = accessory
    this.#log = log
    this.#logChange = createChangeLogger(log)

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
      .onGet(() => this.#targetToShow(this.#currentState()) ?? HomeKitSecurityTarget.DISARM)
      .onSet((value) => this.#handleTargetState(value))
  }

  get deviceId(): string {
    return (this.#accessory.context as PartitionAccessoryContext).deviceId
  }

  /**
   * Republish the name when Alarm.com reports a different one.
   *
   * The constructor sets it once, and the constructor does not re-run for an
   * existing handler — so a device renamed at the panel kept its old HomeKit
   * name until Homebridge restarted, even though the platform was already
   * writing the new one into the accessory context.
   */
  updateName(displayName: string): void {
    const { Characteristic } = this.#platform
    if (this.#service.getCharacteristic(Characteristic.Name).value !== displayName) {
      this.#service.updateCharacteristic(Characteristic.Name, displayName)
    }
  }

  /** The panel's name, falling back to its ID when Alarm.com omits one. */
  get #name(): string {
    return this.#attributes?.description ?? this.deviceId
  }

  /**
   * The state to show, or `undefined` when the panel's state is unrecognised.
   *
   * Kept separate from the characteristic write so an unmappable state can
   * leave the previous value alone. HAP still needs *some* value before the
   * first reading, which is the only case that falls back to disarmed.
   */
  #displayedState(): number | undefined {
    if (!this.#attributes) {
      return undefined
    }
    return toDisplayedSecurityState(this.#attributes)
  }

  #currentState(): number {
    return this.#displayedState() ?? HomeKitSecurityState.DISARMED
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
  #targetToShow(displayedState: number): number | undefined {
    if (this.#targetState !== null) {
      return this.#targetState
    }
    if (displayedState === HomeKitSecurityState.ALARM_TRIGGERED) {
      return this.#lastShownTarget
    }
    return displayedState
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

    const { Perms } = this.#platform.api.hap
    const readOnly = [Perms.PAIRED_READ, Perms.NOTIFY]

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
        ? [...readOnly, Perms.PAIRED_WRITE]
        : readOnly,
    })
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

  /**
   * Refresh the HomeKit characteristic properties when their inputs change.
   *
   * Computing them only on the first reading meant a panel that later gained
   * night arming, or an account that was granted permission to arm, kept the
   * first reading's properties for the life of the process.
   */
  #syncTargetStateProps(attributes: PartitionAttributes): void {
    const canChangeState = this.#canChangeState(attributes)
    const signature = `${String(canChangeState)}:${String(supportsNightArming(attributes))}`

    if (signature === this.#propsSignature) {
      return
    }

    const isFirstApply = this.#propsSignature === null
    this.#propsSignature = signature
    this.#applyValidTargetStates(attributes)

    if (isFirstApply && !canChangeState) {
      this.#log.warn(
        `The Alarm.com account used cannot change the arming state of "${this.#name}".`,
      )
    }
  }

  /** Push fresh partition attributes into HomeKit. */
  update(resource: Resource<PartitionAttributes>): void {
    const attributes = resource.attributes
    this.#attributes = attributes

    this.#syncTargetStateProps(attributes)

    const { Characteristic } = this.#platform
    const displayedState = this.#displayedState()

    // Reported before the unrecognised-state branch below, so an unmappable
    // reading cannot swallow the edge into or out of an active alarm.
    this.#reportAlarmState(attributes)

    if (displayedState === undefined) {
      // Never guess. Showing a green, safe-looking tile for a panel whose real
      // state is unknown is the one failure mode a security integration must
      // not have, so the previous value stands and the tile is flagged faulty.
      this.#log.warn(
        `"${this.#name}" reported an arming state this plugin does not recognise (${String(attributes.state)}); `
        + 'leaving the previous state in place and flagging a fault.',
      )
      this.#service.updateCharacteristic(
        Characteristic.StatusFault,
        Characteristic.StatusFault.GENERAL_FAULT,
      )
      // Still expire a pending target. Otherwise a panel stuck on an unmapped
      // state leaves the Home app showing "Arming…" indefinitely.
      this.#expireUnconfirmedTarget()
      return
    }

    this.#service.updateCharacteristic(
      Characteristic.SecuritySystemCurrentState,
      displayedState,
    )

    this.#resolveTargetState(displayedState)

    const targetToShow = this.#targetToShow(displayedState)
    if (targetToShow !== undefined) {
      this.#lastShownTarget = targetToShow
      this.#service.updateCharacteristic(
        Characteristic.SecuritySystemTargetState,
        targetToShow,
      )
    }

    applyStatusFault(this.#service, Characteristic, attributes.isMalfunctioning)

    this.#logChange(this.#name, toSecurityStateLabel(displayedState))
  }

  /**
   * Stop overriding the target once the panel confirms it, or gives up.
   *
   * The expiry matters because confirmation is not guaranteed: a night arm is
   * sent as a stay command, so the panel lands on a state that never equals the
   * requested target, and an arm the user aborts at the keypad never arrives at
   * all. Without it the Home app shows "Arming…" indefinitely.
   */
  #resolveTargetState(currentState: number): void {
    if (this.#targetState === null) {
      return
    }

    if (this.#targetState === currentState) {
      this.#targetState = null
      return
    }

    this.#expireUnconfirmedTarget(currentState)
  }

  /** Drop a pending target the panel has had long enough to confirm. */
  #expireUnconfirmedTarget(currentState?: number): void {
    if (this.#targetState === null || Date.now() - this.#targetSetAt < PARTITION_TARGET_SETTLE_MS) {
      return
    }

    const reached = currentState === undefined
      ? 'a state this plugin does not recognise'
      : toSecurityStateLabel(currentState)
    this.#log.info(
      `"${this.#name}" did not reach ${toSecurityStateLabel(this.#targetState)}; showing ${reached} instead.`,
    )
    this.#targetState = null
  }

  /** Warn on the edge into alarm, and say so plainly when it clears. */
  #reportAlarmState(attributes: PartitionAttributes): void {
    const hasActiveAlarm = attributes.hasActiveAlarm === true

    if (hasActiveAlarm && !this.#hasReportedAlarm) {
      this.#log.warn(`Alarm.com reports an active alarm on "${this.#name}"`)
    } else if (!hasActiveAlarm && this.#hasReportedAlarm) {
      this.#log.info(`The alarm on "${this.#name}" has cleared`)
    }

    this.#hasReportedAlarm = hasActiveAlarm
  }


  /**
   * Send an arming change requested from HomeKit.
   *
   * Modifiers are only included when the panel advertises support for them,
   * because Alarm.com rejects the whole command otherwise rather than ignoring
   * the unsupported flag.
   */
  async #handleTargetState(value: CharacteristicValue): Promise<void> {
    const attributes = this.#assertCanCommand()
    const target = Number(value)
    const action = toPartitionAction(target)

    if (!action) {
      throw new this.#platform.api.hap.HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST)
    }

    this.#targetState = target
    this.#targetSetAt = Date.now()

    await this.#sendCommand(action, target, buildCommandOptions(attributes, target))
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
  #assertCanCommand(): PartitionAttributes {
    const attributes = this.#attributes

    if (attributes === null || !this.#canChangeState(attributes)) {
      this.#log.error(new ReadOnlyPartitionError(this.#name).message)
      throw new this.#platform.api.hap.HapStatusError(HAPStatus.INSUFFICIENT_PRIVILEGES)
    }

    return attributes
  }

  async #sendCommand(
    action: PartitionAction,
    target: number,
    options: { nightArming: boolean, forceBypass: boolean },
  ): Promise<void> {
    const startedAt = Date.now()

    try {
      await this.#withCommandDeadline(
        this.#platform.client.commandPartition(this.deviceId, action, options),
      )

      this.#log.info(
        `${this.#name}: ${toSecurityStateLabel(target)} (Latency: ${Date.now() - startedAt}ms)`,
      )


      // Recorded through the change logger so the confirming poll, which will
      // report the same state, does not emit a second identical info line
      // without the latency figure.
      this.#logChange(this.#name, toSecurityStateLabel(target))
      this.#platform.recordCommand()
      // Arming takes 20-30 seconds to settle at the panel, so the confirming
      // read is left to the next poll or event rather than done inline.
      this.#platform.requestDeviceRefresh(this.deviceId)
    } catch (error) {
      this.#targetState = null
      this.#log.error(
        `Failed to ${action} partition ${this.deviceId} after ${Date.now() - startedAt}ms: ${sanitizeError(error)}`,
      )
      throw new this.#platform.api.hap.HapStatusError(
        error instanceof TimeoutError
          ? HAPStatus.OPERATION_TIMED_OUT
          : HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      )
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
  async #withCommandDeadline<T>(command: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined

    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new TimeoutError(
          `Alarm.com did not answer the command within ${PARTITION_COMMAND_DEADLINE_MS}ms`,
        )),
        PARTITION_COMMAND_DEADLINE_MS,
      )
      timer.unref?.()
    })

    try {
      return await Promise.race([command, deadline])
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Choose the modifiers to send with an arming command.
 *
 * Force-bypass is asked about for the mode actually being requested. Reading
 * the flag off `ArmedStay` for every mode meant a panel offering it only under
 * `ArmedAway` never received it, and away arming failed with open sensors that
 * the Alarm.com app would have bypassed.
 */
function buildCommandOptions(
  attributes: PartitionAttributes,
  target: number,
): { nightArming: boolean, forceBypass: boolean } {
  return {
    nightArming: target === HomeKitSecurityTarget.NIGHT_ARM,
    forceBypass: acceptsArmingModifier(attributes, armingModeFor(target), ArmingModifier.FORCE_ARM)
      && attributes.hasOpenBypassableSensors === true,
  }
}
