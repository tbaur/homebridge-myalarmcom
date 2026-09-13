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
import {
  MS_PER_SECOND,
  PARTITION_COMMAND_DEADLINE_MS,
  PARTITION_TARGET_SETTLE_MS,
} from '../settings'
import {
  ArmingModifier,
  acceptsArmingModifier,
  isNightArmed,
  supportsNightArming,
  type PartitionAttributes,
  type PartitionAction,
  type Resource,
} from '../types/alarm'
import type { Logger } from '../utils/logger'
import { createChangeLogger } from './change-log'
import type { ChangeLogger } from './change-log'
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

/**
 * One command attempt, carried so its outcome can be reported whenever it lands.
 *
 * These three travel together because a command outlives the reply to HomeKit:
 * by the time it finishes, the local variables that described it are long gone
 * and another command may have started.
 */
/** A target requested while another command was still out at Alarm.com. */
interface QueuedRequest {
  action: PartitionAction
  target: number
  options: { nightArming: boolean, forceBypass: boolean }
}

interface CommandAttempt {
  /** The HomeKit state this command is trying to reach. */
  target: number
  /** When the request left, for reporting how long the panel took. */
  startedAt: number
  /** Sequence value, so an attempt can recognise it has been superseded. */
  token: number
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
  /**
   * Counts commands, so a slow one can tell it has been superseded.
   *
   * A command outlives the HAP deadline by up to fifty seconds, and HomeKit is
   * free to send another the moment that deadline passes. Comparing this at the
   * end against the value taken at the start is how an outcome knows whether
   * the tile is still its to speak for.
   */
  #commandSequence = 0

  /**
   * The command currently out at Alarm.com, or null when nothing is running.
   *
   * Alarm.com applies commands in *completion* order, not request order, so two
   * in flight at once means the panel lands on whichever finishes last. Measured
   * live: an away arm and a disarm sent twelve seconds apart, the disarm
   * returning accepted in 1.1s against a panel still inside its exit delay — and
   * so still reporting disarmed — and the arm it was meant to replace landing
   * afterwards. The panel finished armed while HomeKit had been told disarmed.
   */
  #inFlight: Promise<CommandOutcome> | null = null

  /**
   * The newest target requested while something was already running.
   *
   * One slot, latest wins. Nobody wants the third of four taps replayed; they
   * want the last one. Holding it costs nothing visible because HomeKit has
   * already been answered at the HAP deadline and the pending target keeps the
   * tile on the requested state either way.
   */
  #queued: QueuedRequest | null = null
  /** Reports a state at info only when it differs from the previous one. */
  readonly #logChange: ChangeLogger
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

  /**
   * Answer a HomeKit read of the arming mode, or refuse to answer at all.
   *
   * The undefined case is reachable and used to answer `DISARM`. It happens
   * when the very first reading has an alarm sounding: {@link update} rightly
   * withholds the target write, so no target has ever been published, and
   * {@link #targetToShow} has nothing to fall back on. Substituting "disarmed"
   * there told HomeKit a house with its alarm going off was unarmed — the exact
   * false-safety signal {@link #requireDisplayedState} exists to prevent, so it
   * refuses the same way.
   */
  #readTargetState(): number {
    const target = this.#targetToShow(this.#requireDisplayedState())
    if (target === undefined) {
      throw new this.#platform.api.hap.HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE)
    }
    return target
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
   *
   * The list must also cover any state the panel can *report*, which is not the
   * same set. Night arming is generally available at the keypad whatever the
   * options advertise, and a panel night-armed that way reports state 4 to an
   * account that cannot command it. Withholding the value then left the tile
   * unable to describe the panel at all: HAP refused the matching target as out
   * of range and the Home app showed a system stuck mid-transition. This is the
   * same trap {@link #targetToShow} documents for `ALARM_TRIGGERED`.
   */
  #applyValidTargetStates(attributes: PartitionAttributes): void {
    const { Characteristic } = this.#platform

    const validValues = [
      HomeKitSecurityTarget.STAY_ARM,
      HomeKitSecurityTarget.AWAY_ARM,
      HomeKitSecurityTarget.DISARM,
    ]

    if (supportsNightArming(attributes) || isNightArmed(attributes)) {
      validValues.push(HomeKitSecurityTarget.NIGHT_ARM)
    }

    const { Perms } = this.#platform.api.hap
    const readOnly = [Perms.PAIRED_READ, Perms.NOTIFY]

    // A partition HomeKit may not command gets a read-only tile rather than
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
   * Whether HomeKit may arm or disarm this partition.
   *
   * Both gates must pass: `allowHomeKitArming` (the install opted into a keypad)
   * and a literal `hasPermissionToChangeState: true` from Alarm.com. Fails
   * closed. Responses are parsed without runtime validation, so an absent, null
   * or renamed field arrives as `undefined`, and the safe answer to "may this
   * account disarm a physical alarm?" when nobody knows is no.
   */
  #canChangeState(attributes: PartitionAttributes): boolean {
    return this.#platform.isHomeKitArmingAllowed && attributes.hasPermissionToChangeState === true
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
    // Every input to the properties belongs in the signature. Night arming is
    // two of them, because the panel entering that state changes the offered
    // values just as advertising it does.
    const signature = [
      canChangeState,
      supportsNightArming(attributes),
      isNightArmed(attributes),
    ].map(String).join(':')

    if (signature === this.#propsSignature) {
      return
    }

    const isFirstApply = this.#propsSignature === null
    this.#propsSignature = signature
    this.#applyValidTargetStates(attributes)

    if (isFirstApply && !canChangeState) {
      if (!this.#platform.isHomeKitArmingAllowed) {
        this.#log.info(
          `HomeKit arming is turned off for "${this.#name}"; the tile is display-only.`,
        )
      } else {
        this.#log.warn(
          `The Alarm.com account used cannot change the arming state of "${this.#name}".`,
        )
      }
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

    this.#logChange.report(this.#name, toSecurityStateLabel(displayedState))
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
   * `forceBypass` is gated on the panel advertising it for the mode being
   * requested. `nightArming` is not gated here at all: the mode is withheld
   * from the tile's valid values when unsupported, so the request cannot arrive.
   *
   * An unadvertised modifier is not necessarily fatal — `forceBypass: true` was
   * measured accepted by a panel advertising only `BYPASS_SENSORS` — but the
   * gate stays, because sending a flag the panel never offered is not something
   * to do on a guess with someone's alarm.
   */
  async #handleTargetState(value: CharacteristicValue): Promise<void> {
    const attributes = this.#assertCanCommand()
    const target = Number(value)
    const action = toPartitionAction(target)

    if (!action) {
      throw new this.#platform.api.hap.HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST)
    }

    if (action !== 'disarm') {
      this.#refuseArmOverOpenSensors(attributes, target)
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
   * Refuse an arm the panel is certain to reject, before spending a minute on it.
   *
   * A panel asked to arm over an open contact does not answer at all. The
   * request stays open until the client's own ceiling expires, so the user
   * waited a full minute to be told something the plugin already knew the
   * moment they tapped. Answering now costs nothing and reverts the tile at
   * once.
   *
   * The open sensors are named because "close the sensor" is not usable advice
   * when the whole question is which one.
   *
   * Asks {@link willBypassOpenSensors} rather than the setting, because the
   * setting alone is not enough for a bypass to happen. Waving the arm through
   * on the setting while the command builder withheld the flag left the setting
   * switched on, no bypass sent, and the full sixty-second hang back — the very
   * thing this check exists to remove.
   */
  #refuseArmOverOpenSensors(attributes: PartitionAttributes, target: number): void {
    const isBypassAllowed = this.#platform.isSensorBypassAllowed
    if (willBypassOpenSensors(attributes, target, isBypassAllowed)) {
      return
    }

    const open = this.#platform.listOpenContacts()
    if (open.length === 0) {
      return
    }

    const isSingle = open.length === 1
    // Which advice to give depends on why no bypass is coming. Telling someone
    // to switch on a setting they already switched on reads as the plugin not
    // listening, when the real answer is that their panel will not do it.
    const remedy = isBypassAllowed
      ? `This panel does not offer sensor bypass for that mode, so ${isSingle ? 'it has' : 'they have'} to be closed.`
      : `Close ${isSingle ? 'it' : 'them'}, or turn on "Allow arming with open sensors" `
        + 'to have the panel bypass them.'

    this.#log.error(
      `${this.#name}: cannot reach ${toSecurityStateLabel(target)} because `
      + `${formatNameList(open)} ${isSingle ? 'is' : 'are'} open. ${remedy}`,
    )

    throw new this.#platform.api.hap.HapStatusError(HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE)
  }

  /**
   * Refuse the command unless HomeKit is allowed to arm this partition.
   *
   * Both `allowHomeKitArming` and a known Alarm.com arm permission must pass.
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
      if (attributes !== null && !this.#platform.isHomeKitArmingAllowed) {
        this.#log.error(`HomeKit arming is turned off; "${this.#name}" is display-only.`)
      } else {
        this.#log.error(new ReadOnlyPartitionError(this.#name).message)
      }
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
    if (this.#inFlight !== null) {
      // Held rather than sent. Sending both is what let the panel finish on the
      // countermanded one; sending them in order makes the panel land on what
      // was asked for last, which is the only ordering that matches intent.
      this.#queued = { action, target, options }
      // Claiming a token here retires the running command's ownership of the
      // tile, so it cannot report "confirmed" for a state the user has since
      // changed their mind about.
      this.#commandSequence++
      this.#log.info(
        `${this.#name}: holding ${toSecurityStateLabel(target)} until the command already `
        + 'running finishes, so the panel ends where you last asked',
      )
      return
    }

    // The token is claimed before anything is sent. Answering HomeKit at the
    // deadline frees it to accept another write while this command is still
    // running, so an outcome landing later has to be able to tell whether it is
    // still the one the user is waiting on.
    const attempt: CommandAttempt = {
      target,
      startedAt: Date.now(),
      token: ++this.#commandSequence,
    }

    // Announced here rather than when the wait gives up, so its timestamp is
    // the moment the request left. Logging it at the deadline instead put a
    // "sent" line nine seconds late, and the duration on the following line
    // then disagreed with the gap between the two.
    this.#log.info(`${this.#name}: requesting ${toSecurityStateLabel(target)}`)

    const outcome = this.#startCommand(action, options, attempt)
    this.#inFlight = outcome
    const settled = await this.#awaitWithinHapWindow(outcome)

    if (settled === null) {
      this.#log.debug(
        `${this.#name}: ${action} still in flight at the HAP deadline, answering HomeKit without it`,
      )
      // Both the command's rejection and the handler's are owned. The handler
      // logs, refreshes and records, any of which can throw; an unhandled
      // rejection from here has no caller left to catch it and takes the
      // process down, which for a child bridge means every accessory on it.
      void outcome
        .then((late) => this.#settle(late, attempt))
        .catch((error: unknown) => {
          this.#log.debug(`${this.#name}: failed to record a late ${action}: ${String(error)}`)
          this.#releaseAndDrain()
        })
      return
    }

    this.#settle(settled, attempt)

    if (!settled.isOk) {
      throw new this.#platform.api.hap.HapStatusError(
        settled.error instanceof TimeoutError
          ? HAPStatus.OPERATION_TIMED_OUT
          : HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      )
    }
  }

  /**
   * Report an outcome, then let whatever was waiting behind it go.
   *
   * Reporting is wrapped so that a throw on the way out — the logger and the
   * refresh both call into Homebridge — cannot strand `#inFlight` and leave the
   * partition unable to send anything for the rest of the process's life.
   */
  #settle(outcome: CommandOutcome, attempt: CommandAttempt): void {
    try {
      this.#recordOutcome(outcome, attempt)
    } finally {
      this.#releaseAndDrain()
    }
  }

  /** Mark the slot free and send the newest target that was held for it. */
  #releaseAndDrain(): void {
    this.#inFlight = null

    const next = this.#queued
    if (next === null) {
      return
    }
    this.#queued = null

    // HomeKit stopped waiting for this long ago, so there is nobody to throw
    // to; #recordOutcome has already put the outcome in the log either way.
    void this.#sendCommand(next.action, next.target, next.options).catch(() => {})
  }

  /**
   * Start the command and give it a handler, once, here.
   *
   * Its single caller consumes the returned promise twice — once in the race
   * against the deadline, once in the late handler — so a rejection arriving
   * long after the deadline is still owned and never surfaces as an unhandled
   * rejection.
   *
   * The call is wrapped because it can throw *synchronously*, before any
   * promise exists: reading `platform.client` raises `ConfigurationError` when
   * the configuration is unusable. Left uncaught that escaped the set handler
   * as a bare error, so HomeKit reverted the tile with nothing written to the
   * log to say why.
   */
  #startCommand(
    action: PartitionAction,
    options: { nightArming: boolean, forceBypass: boolean },
    attempt: CommandAttempt,
  ): Promise<CommandOutcome> {
    try {
      return this.#platform.client
        .commandPartition(this.deviceId, action, options)
        .then(
          (): CommandOutcome => ({ isOk: true }),
          (error: unknown): CommandOutcome => ({ isOk: false, error }),
        )
    } catch (error) {
      this.#recordOutcome({ isOk: false, error }, attempt)
      throw new this.#platform.api.hap.HapStatusError(
        HAPStatus.SERVICE_COMMUNICATION_FAILURE,
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
  #recordOutcome(outcome: CommandOutcome, attempt: CommandAttempt): void {
    const elapsedMs = Date.now() - attempt.startedAt
    const label = toSecurityStateLabel(attempt.target)

    // A command the user has already replaced must not speak for the one that
    // replaced it. Tapping Away and then Disarm a few seconds later left the
    // Away command still running; when it finished it cleared the pending
    // Disarm and reported "could not reach Armed Away", so the tile the user
    // was watching snapped back with an error about a command they had
    // abandoned. Its result is still worth a debug line, and nothing more.
    if (attempt.token !== this.#commandSequence) {
      this.#log.debug(
        `${this.#name}: superseded ${label} request settled after ${toSeconds(elapsedMs)} `
        + `(${outcome.isOk ? 'accepted' : 'failed'}); a newer request owns the tile`,
      )
      // Deliberately no read here, unlike every other exit from this method.
      // A command can only be superseded by a newer target being held, and
      // that held command is sent the moment this returns, so it reads back on
      // its own. Reading now would be reading a panel that is still moving:
      // measured live, an away arm returned accepted at 18.4s and the panel
      // did not report armed until 20.0s. A reading taken in that gap can
      // match the pending target by coincidence and retire it while the real
      // command is still running.
      return
    }

    if (!outcome.isOk) {
      this.#targetState = null
      this.#log.error(
        `${this.#name}: could not reach ${label} — ${describeCommandFailure(outcome.error, elapsedMs)}`,
      )
      // Read back even on failure. HomeKit may already have been told the
      // request was accepted, so the panel's real state is the only thing that
      // corrects the tile before the next poll comes round. Nothing can be
      // held at this point: holding one bumps the sequence, which would have
      // sent this outcome down the superseded branch above.
      this.#platform.requestDeviceRefresh(this.deviceId)
      return
    }

    // "Accepted", not "confirmed by the panel". The response says Alarm.com
    // took the request, and measured live it says that in 1.1s for a disarm
    // the panel never carried out. The poll is what confirms; if the panel
    // ends somewhere else, the change logger reports that state instead.
    this.#log.info(`${this.#name}: ${label}, accepted in ${toSeconds(elapsedMs)}`)
    // Marked without logging so the confirming poll, which reports this same
    // state, does not repeat it. Priming by reporting emitted a second, nearly
    // identical line immediately after this one.
    this.#logChange.markReported(label)
    this.#platform.recordCommand()
    this.#platform.requestDeviceRefresh(this.deviceId)
  }
}

/** A duration as someone reading a log would say it, not a millisecond count. */
function toSeconds(ms: number): string {
  return `${(ms / MS_PER_SECOND).toFixed(1).replace(/\.0$/, '')}s`
}

/** Names as a person would list them: "A", "A and B", "A, B and C". */
function formatNameList(names: readonly string[]): string {
  if (names.length <= 1) {
    return names[0] ?? ''
  }

  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Say what went wrong in terms of what the user can do about it.
 *
 * The raw error said none of that: it reported the timeout twice, once wrapped
 * in the other, alongside the full request URL. Nor does this call a timeout a
 * refusal any more. The refusal the plugin can see coming — an open contact
 * with bypass off — is now answered before the request is sent, so what reaches
 * here is genuinely unexplained and says so instead of guessing.
 */
function describeCommandFailure(error: unknown, elapsedMs: number): string {
  if (error instanceof TimeoutError) {
    return `Alarm.com did not reply within ${toSeconds(elapsedMs)}. `
      + 'The panel may still be acting on the request; check the Alarm.com app before retrying.'
  }

  return sanitizeError(error)
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
/**
 * Whether an arm to this mode will actually bypass anything left open.
 *
 * Both the user's setting and the panel's advertisement have to agree, and the
 * single source of that answer lives here. It was previously decided twice —
 * once to gate the fail-fast refusal, once to build the command — and the two
 * copies did not ask the same question, so a panel that does not advertise
 * `BYPASS_SENSORS` skipped the refusal *and* sent no bypass flag.
 */
function willBypassOpenSensors(
  attributes: PartitionAttributes,
  target: number,
  isBypassAllowed: boolean,
): boolean {
  return isBypassAllowed
    && acceptsArmingModifier(attributes, armingModeFor(target), ArmingModifier.BYPASS_SENSORS)
}

function buildCommandOptions(
  attributes: PartitionAttributes,
  target: number,
  isBypassAllowed: boolean,
): { nightArming: boolean, forceBypass: boolean } {
  return {
    nightArming: target === HomeKitSecurityTarget.NIGHT_ARM,
    forceBypass: willBypassOpenSensors(attributes, target, isBypassAllowed),
  }
}
