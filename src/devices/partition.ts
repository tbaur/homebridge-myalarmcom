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

/** How a command finished, once it eventually did. */
type CommandOutcome = { isOk: true } | { isOk: false, error: unknown }

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
      .onGet(() => this.#readCurrentState())

    this.#service
      .getCharacteristic(Characteristic.SecuritySystemTargetState)
      .onGet(() => this.#readTargetState())
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
   * The state to show, or `undefined` when there is no reading yet or the
   * panel's state is unrecognised.
   *
   * Kept separate from the characteristic write so an unmappable state can
   * leave the previous value alone. HAP needs *some* value to publish, so
   * {@link update} withholds the write rather than invent one. A read is under
   * no such constraint and refuses instead: see {@link #requireDisplayedState}.
   */
  #displayedState(): number | undefined {
    if (!this.#attributes) {
      return undefined
    }
    return toDisplayedSecurityState(this.#attributes)
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

  /** Answer a HomeKit read of the panel's state, or refuse to answer at all. */
  #readCurrentState(): number {
    return this.#requireDisplayedState()
  }

  /** Answer a HomeKit read of the arming mode, or refuse to answer at all. */
  #readTargetState(): number {
    return this.#targetToShow(this.#requireDisplayedState()) ?? HomeKitSecurityTarget.DISARM
  }

  /**
   * The state to answer a read with, or a refusal to answer.
   *
   * Two situations leave the panel's real state unknown: no reading has arrived
   * yet, as after a restart during an Alarm.com outage; and a reading whose
   * state Alarm.com describes in terms this plugin cannot map, which
   * {@link update} has already flagged as a fault. Answering "disarmed" for
   * either is a false-safety signal on a physical alarm, because neither the
   * Home app nor an automation can tell it apart from a panel that genuinely is
   * disarmed. HomeKit is told the accessory cannot be reached instead, and
   * shows "No Response".
   *
   * Refusing also protects what {@link update} was already trying to do. It
   * withholds the write on an unmappable state so the last known value stays
   * put; a read that answered "disarmed" would be written straight back into
   * that cached value by HAP, undoing it.
   */
  #requireDisplayedState(): number {
    const displayedState = this.#displayedState()
    if (displayedState === undefined) {
      throw new this.#platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
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

    await this.#sendCommand(
      action,
      target,
      buildCommandOptions(attributes, target, this.#platform.isSensorBypassAllowed),
    )
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

  /**
   * Send an arming command without making HomeKit wait for the panel.
   *
   * Alarm.com holds the command request open until the panel acknowledges,
   * measured at 17-19 seconds for a real state change against 1.4 seconds for a
   * no-op. HAP abandons a set handler at 10 seconds, so waiting for the answer
   * reported a failure for every arm that was about to succeed. The deadline
   * therefore ends the *wait*, not the command: HomeKit is told the request was
   * accepted, the pending target keeps the Home app on the requested state, and
   * the real outcome is logged and reconciled whenever it arrives.
   */
  async #sendCommand(
    action: PartitionAction,
    target: number,
    options: { nightArming: boolean, forceBypass: boolean },
  ): Promise<void> {
    const startedAt = Date.now()

    // Given a handler exactly once, here. Both branches below read this rather
    // than the raw command, so a rejection arriving long after the deadline is
    // still owned and never surfaces as an unhandled rejection.
    const outcome: Promise<CommandOutcome> = this.#platform.client
      .commandPartition(this.deviceId, action, options)
      .then(
        (): CommandOutcome => ({ isOk: true }),
        (error: unknown): CommandOutcome => ({ isOk: false, error }),
      )

    const settled = await this.#awaitWithinHapWindow(outcome)

    if (settled === null) {
      this.#log.info(
        `${this.#name}: ${toSecurityStateLabel(target)} sent, waiting for the panel to confirm`,
      )
      void outcome.then((late) => this.#recordOutcome(late, action, target, startedAt))
      return
    }

    this.#recordOutcome(settled, action, target, startedAt)

    if (!settled.isOk) {
      throw new this.#platform.api.hap.HapStatusError(
        settled.error instanceof TimeoutError
          ? HAPStatus.OPERATION_TIMED_OUT
          : HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      )
    }
  }

  /**
   * Wait for a command, or stop waiting before HAP cuts the handler off.
   *
   * @returns The outcome, or `null` when the deadline came first.
   */
  async #awaitWithinHapWindow(outcome: Promise<CommandOutcome>): Promise<CommandOutcome | null> {
    let timer: NodeJS.Timeout | undefined

    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), PARTITION_COMMAND_DEADLINE_MS)
      timer.unref?.()
    })

    try {
      return await Promise.race([outcome, deadline])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Log a finished command and reconcile the pending target against it. */
  #recordOutcome(
    outcome: CommandOutcome,
    action: PartitionAction,
    target: number,
    startedAt: number,
  ): void {
    const elapsedMs = Date.now() - startedAt

    if (!outcome.isOk) {
      this.#targetState = null
      this.#log.error(
        `Failed to ${action} partition ${this.deviceId} after ${elapsedMs}ms: ${sanitizeError(outcome.error)}`,
      )
      // Read back even on failure. HomeKit may already have been told the
      // request was accepted, so the panel's real state is the only thing that
      // corrects the tile before the next poll comes round.
      this.#platform.requestDeviceRefresh(this.deviceId)
      return
    }

    this.#log.info(`${this.#name}: ${toSecurityStateLabel(target)} (Latency: ${elapsedMs}ms)`)
    // Recorded through the change logger so the confirming poll, which will
    // report the same state, does not emit a second identical info line
    // without the latency figure.
    this.#logChange(this.#name, toSecurityStateLabel(target))
    this.#platform.recordCommand()
    this.#platform.requestDeviceRefresh(this.deviceId)
  }
}

/**
 * Choose the modifiers to send with an arming command.
 *
 * Force-bypass is asked about for the mode actually being requested. Reading
 * the flag off `ArmedStay` for every mode meant a panel offering it only under
 * `ArmedAway` never received it, and away arming failed with open sensors that
 * the Alarm.com app would have bypassed.
 *
 * The capability checked is BYPASS_SENSORS, which is what panels actually
 * advertise. FORCE_ARM was checked before and no observed panel offers it, so
 * the flag never went out and arming over an open zone hung until the request
 * timed out. `hasOpenBypassableSensors` is deliberately not consulted either:
 * it read false on a live panel that had an open bypassable contact and did
 * bypass it when asked, so gating on it suppressed the flag just as reliably.
 *
 * Sending the flag with nothing open is a no-op, which is why the decision is
 * the user's standing preference rather than a guess at the current state.
 */
function buildCommandOptions(
  attributes: PartitionAttributes,
  target: number,
  isBypassAllowed: boolean,
): { nightArming: boolean, forceBypass: boolean } {
  return {
    nightArming: target === HomeKitSecurityTarget.NIGHT_ARM,
    forceBypass: isBypassAllowed
      && acceptsArmingModifier(attributes, armingModeFor(target), ArmingModifier.BYPASS_SENSORS),
  }
}
