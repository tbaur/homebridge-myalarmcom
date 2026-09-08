#!/usr/bin/env node
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Drive the shipping `PartitionAccessory` against a live account.
 *
 * `verify.mjs` exercises the client. This exercises the accessory, and the
 * difference is the whole point: every HomeKit-facing decision — refusing an
 * arm that cannot succeed, deciding whether a bypass flag goes out, telling a
 * superseded command to keep quiet, choosing which target values the tile may
 * hold — lives in `PartitionAccessory` and is unreachable from a script that
 * only calls the client. `verify.mjs` goes as far as hand-copying
 * `buildCommandOptions`, so it can happily agree with a bug in the original.
 *
 * Services and characteristics here are the real hap-nodejs classes, so a
 * write goes through the same validation and the same `HapStatusError` path it
 * would in a running Homebridge. Only the Homebridge shell is faked.
 *
 * Run `npm run build` first.
 *
 * Usage:
 *   node scripts/probe-accessory.mjs --night-display   read-only, sends nothing
 *   node scripts/probe-accessory.mjs --refusal         expects NO command to be sent
 *   node scripts/probe-accessory.mjs --bypass          really arms, then disarms
 *   node scripts/probe-accessory.mjs --supersede       really arms, then disarms
 *   node scripts/probe-accessory.mjs --all             all of the above, in order
 *
 * Every scenario that can reach the panel asks for typed confirmation and
 * always attempts a disarm on the way out, including after Ctrl-C.
 *
 * Output names your devices and their open/closed state. Treat it as a floor
 * plan of your house with the doors labelled.
 */

import { createRequire } from 'node:module'
import { stdout } from 'node:process'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { Characteristic, HapStatusError, Perms, Service, uuid } from '@homebridge/hap-nodejs'

import { handleHelp, hasFlag, readNumericFlag } from './lib/cli.mjs'
import { createTerminalLogger, DIST_DIR, requireBuild } from './lib/plugin-logger.mjs'
import { confirmPhrase, resolveCredentials } from './lib/prompt.mjs'
import { redactFreeText } from './lib/scrub.mjs'

handleHelp(`
Drive the compiled PartitionAccessory against a live Alarm.com account.

  node scripts/probe-accessory.mjs [scenarios]

  --night-display   Read your partition, then feed the accessory a synthetic
                    night-armed copy of it and read back the target values it
                    offers. Read-only: no command is ever sent.
  --refusal         With bypass off and a contact open, ask the accessory to
                    arm. It should refuse in about a second and send nothing.
  --bypass          With bypass on and a contact open, ask it to arm. It should
                    send forceBypass and the panel should arm. Then disarms.
  --supersede       Arm away, wait past the HAP deadline, then disarm while the
                    arm is still in flight. The arm must not report an error or
                    disturb the disarm. Then disarms.
  --all             Every scenario, in that order.

  --wait <seconds>  How long --supersede waits before the second command
                    (default 12; must exceed the 9s HAP deadline).
  --verbose         Include the plugin's debug lines from the client too.
  -h, --help        Show this message.

--refusal, --bypass and --supersede all command a live security panel. Each
asks for typed confirmation, and a disarm is always attempted on the way out.
`)

requireBuild()

const require = createRequire(import.meta.url)
const { SessionManager } = require(join(DIST_DIR, 'api/session-manager.js'))
const { AlarmComClient } = require(join(DIST_DIR, 'api/client.js'))
const { PartitionAccessory } = require(join(DIST_DIR, 'devices/partition.js'))
const mappers = require(join(DIST_DIR, 'utils/mappers.js'))
const alarmTypes = require(join(DIST_DIR, 'types/alarm.js'))
const settings = require(join(DIST_DIR, 'settings.js'))

const { HomeKitSecurityTarget } = mappers
const { PartitionState } = alarmTypes

/** Perms the accessory reads off `api.hap` when publishing the characteristic. */
const PERMS = {
  PAIRED_READ: Perms.PAIRED_READ,
  PAIRED_WRITE: Perms.PAIRED_WRITE,
  NOTIFY: Perms.NOTIFY,
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Stand-in for Homebridge's `PlatformAccessory`, holding real HAP services. */
class FakePlatformAccessory {
  services = []
  context = {}

  constructor(displayName, UUID) {
    this.displayName = displayName
    this.UUID = UUID
  }

  getService(target) {
    return this.services.find((service) => service.UUID === target.UUID)
  }

  addService(target, ...args) {
    const service = new target(...args)
    this.services.push(service)
    return service
  }
}

/**
 * Logger that keeps what the accessory said, with the time it said it.
 *
 * The timing is half the evidence. "Refused" is only the right answer if it
 * arrives in about a second; the same words sixty seconds later are the bug.
 */
function createRecordingLog() {
  const entries = []

  const record = (level) => (message, ...parameters) => {
    const suffix = parameters
      .map((parameter) => (typeof parameter === 'string' ? parameter : JSON.stringify(parameter)))
      .join(' ')
    entries.push({ level, atMs: Date.now(), text: suffix ? `${message} ${suffix}` : message })
  }

  const log = () => undefined
  log.debug = record('debug')
  log.info = record('info')
  log.warn = record('warn')
  log.error = record('error')
  log.log = () => undefined
  log.success = () => undefined
  log.entries = entries
  return log
}

/**
 * Build the accessory under test on top of the real client.
 *
 * `listOpenContacts` is answered from a live sensor read rather than a fixture,
 * because the refusal is only meaningful if the door really is open. The real
 * platform applies the same single-partition condition, which is mirrored here.
 */
function mountAccessory({
  client, partitionId, displayName, isBypassAllowed, openContacts, disarmAfter,
}) {
  const log = createRecordingLog()
  const accessory = new FakePlatformAccessory(displayName, uuid.generate(`probe-${partitionId}`))
  accessory.context = { deviceId: partitionId, kind: 'partition', displayName }

  const sent = []
  const refreshes = []
  let commandCount = 0

  const platform = {
    Service,
    Characteristic,
    api: { hap: { uuid, Perms: PERMS, HapStatusError } },
    // The genuine client, so a command really leaves for Alarm.com.
    client: {
      commandPartition: (id, action, options) => {
        sent.push({ id, action, options, atMs: Date.now() })
        // Armed here, at the one place a command really leaves, rather than at
        // each call site. Set per scenario it was missing from --refusal, whose
        // whole point is that nothing should be sent — so the one run whose
        // failure mode is an unexpected arm was the one run with no cleanup.
        if (disarmAfter) {
          disarmAfter.armed = true
        }
        return client.commandPartition(id, action, options)
      },
    },
    // Timestamped, because "a refresh happened" is trivially true after any
    // successful command. The question is whether one happened *after* a
    // particular outcome landed.
    requestDeviceRefresh: (id) => refreshes.push({ id, atMs: Date.now() }),
    recordCommand: () => { commandCount += 1 },
    isSensorBypassAllowed: isBypassAllowed,
    listOpenContacts: () => openContacts,
  }

  return {
    accessory: new PartitionAccessory(platform, accessory, log),
    service: accessory.services[0],
    log,
    sent,
    refreshes,
    countCommands: () => commandCount,
  }
}

/** Ask HomeKit's question the way HomeKit asks it. */
function targetCharacteristic(service) {
  return service.getCharacteristic(Characteristic.SecuritySystemTargetState)
}

/**
 * Sample the partition for as long as a scenario runs.
 *
 * One reading at the end is not enough, and reporting it as though it were is
 * how this probe drew a wrong conclusion: a panel found disarmed afterwards
 * may never have armed, may have armed and been reverted, or may have started
 * an exit delay that the second command cancelled. Those are three different
 * findings and the end state is identical in all three.
 *
 * `desiredState` is sampled alongside `state` because it is what separates
 * them. A panel counting down an exit delay still reports `state` 1 while
 * `desiredState` has already moved to the mode it is heading for.
 */
/**
 * Poll the partition until its state stops changing, and return that state.
 *
 * @returns The settled state, or the last one seen if it never went quiet.
 */
async function readUntilSettled(client, partitionId, { quietMs = 12_000, timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let state
  let lastChangeAt = Date.now()

  while (Date.now() < deadline) {
    try {
      const [resource] = await client.getPartitions([partitionId])
      const current = resource?.attributes?.state
      if (current !== state) {
        state = current
        lastChangeAt = Date.now()
      } else if (Date.now() - lastChangeAt >= quietMs) {
        return state
      }
    } catch {
      // One failed read is not a reason to stop confirming a security panel.
    }
    await sleep(3_000)
  }
  return state
}

/**
 * Wait for a line to appear in the accessory's own log.
 *
 * @returns Whether it appeared before the deadline.
 */
async function waitForLogLine(log, fragment, timeoutMs) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (log.entries.some((entry) => entry.text.includes(fragment))) {
      return true
    }
    await sleep(1_000)
  }
  return false
}

/**
 * Wait until the panel stops changing.
 *
 * Waiting for a *value* is the trap: the panel starts disarmed and ends
 * disarmed, so "wait until disarmed" returned immediately and the run reported
 * a final state twelve seconds in, while the arm was still on its way. Quiet is
 * the only signal that distinguishes "finished" from "has not started".
 *
 * @returns Whether it went quiet before the deadline.
 */
async function waitForPanelToSettle(watcher, { quietMs = 15_000, timeoutMs = 150_000 }) {
  const deadline = Date.now() + timeoutMs
  let lastSeen = watcher.samples.length
  let lastChangeAt = Date.now()

  while (Date.now() < deadline) {
    if (watcher.samples.length !== lastSeen) {
      lastSeen = watcher.samples.length
      lastChangeAt = Date.now()
    } else if (Date.now() - lastChangeAt >= quietMs) {
      return true
    }
    await sleep(2_000)
  }
  return false
}

function watchPartitionStates(client, partitionId, startedAt) {
  const samples = []
  let isStopped = false

  const loop = (async () => {
    while (!isStopped) {
      try {
        const [resource] = await client.getPartitions([partitionId])
        const attributes = resource?.attributes ?? {}
        const signature = `${attributes.state}/${attributes.desiredState}/${attributes.hasActiveAlarm}`
        if (samples[samples.length - 1]?.signature !== signature) {
          samples.push({
            atMs: Date.now() - startedAt,
            signature,
            state: attributes.state,
            desiredState: attributes.desiredState,
            hasActiveAlarm: attributes.hasActiveAlarm === true,
          })
        }
      } catch {
        // A read that fails mid-scenario is not worth abandoning the run for.
      }
      await sleep(3_000)
    }
  })()

  return { samples, stop: async () => { isStopped = true; await loop } }
}

/** Print what the panel actually did, next to what the accessory said. */
function reportStateTimeline(samples) {
  stdout.write('\n  Panel, as Alarm.com reported it:\n')
  if (samples.length === 0) {
    stdout.write('    (no readings)\n')
    return
  }
  for (const sample of samples) {
    const seconds = (sample.atMs / 1000).toFixed(1)
    stdout.write(
      `    +${seconds.padStart(5)}s  state=${sample.state} desired=${sample.desiredState}`
      + `  alarm=${sample.hasActiveAlarm}\n`,
    )
  }
}

/**
 * Perform a HomeKit write, recording how long it took and how it ended.
 *
 * A rejection is an outcome, not a failure of the probe: refusing a write is
 * exactly what two of these scenarios are checking for.
 */
async function writeTarget(service, value) {
  const startedAt = Date.now()
  try {
    await targetCharacteristic(service).handleSetRequest(value)
    return { accepted: true, elapsedMs: Date.now() - startedAt }
  } catch (error) {
    return {
      accepted: false,
      elapsedMs: Date.now() - startedAt,
      hapStatus: error?.hapStatus ?? error?.status ?? null,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Print the accessory's own log lines, relative to when the scenario began. */
function reportLog(log, sinceMs, { includeDebug = true } = {}) {
  for (const entry of log.entries) {
    if (!includeDebug && entry.level === 'debug') {continue}
    const seconds = ((entry.atMs - sinceMs) / 1000).toFixed(1)
    stdout.write(`    +${seconds.padStart(5)}s  ${entry.level.padEnd(5)} ${entry.text}\n`)
  }
}

function verdict(isPass, text) {
  stdout.write(`\n  ${isPass ? 'PASS' : 'FAIL'}  ${text}\n`)
  return isPass
}

/**
 * Scenario: a panel reporting night, on an account that cannot command it.
 *
 * Sends nothing. The reading is synthetic because the panel under test omits
 * `ArmedNight` from its options and so cannot be driven into that state over
 * the API — which is precisely the case that used to break. This proves the
 * accessory's half; only a keypad can prove the panel's.
 */
function probeNightDisplay(partition) {
  stdout.write('\n── Night arming: what the tile will accept ──\n')

  const armedNight = {
    ...partition,
    attributes: { ...partition.attributes, state: PartitionState.ARMED_NIGHT, desiredState: PartitionState.ARMED_NIGHT },
  }

  const mounted = mountAccessory({
    client: { commandPartition: () => Promise.reject(new Error('unreachable in this scenario')) },
    partitionId: partition.id,
    displayName: partition.attributes.description ?? partition.id,
    isBypassAllowed: false,
    openContacts: [],
  })

  mounted.accessory.update(armedNight)

  const characteristic = targetCharacteristic(mounted.service)
  const validValues = characteristic.props.validValues ?? []
  const offersNight = validValues.includes(HomeKitSecurityTarget.NIGHT_ARM)

  stdout.write(`  advertises ArmedNight   ${alarmTypes.supportsNightArming(partition.attributes)}\n`)
  stdout.write(`  reports state 4         true (synthetic reading)\n`)
  stdout.write(`  target valid values     [${validValues.join(', ')}]\n`)
  stdout.write(`  current target value    ${characteristic.value}\n`)

  return {
    isPass: verdict(
      offersNight && characteristic.value === HomeKitSecurityTarget.NIGHT_ARM,
      offersNight
        ? 'the tile accepts Night and is showing it'
        : 'Night is missing from validValues, so the tile cannot show a night-armed panel',
    ),
    detail: { validValues, value: characteristic.value, offersNight },
  }
}

/**
 * Scenario: arming refused before anything is sent.
 *
 * Confirmation is still required even though a correct run sends nothing,
 * because an incorrect one sends an arm.
 */
async function probeRefusal({ client, partition, openContacts, disarmAfter }) {
  stdout.write('\n── Refusal: bypass off, a contact open ──\n')
  stdout.write(`  open contacts   ${openContacts.join(', ')}\n`)
  stdout.write('  expected        refusal in about a second, nothing sent to the panel\n')
  stdout.write('  if it is wrong  an arm command goes out and your panel arms\n')

  if (!await confirmPhrase('Run it? A correct run sends nothing to the panel.', 'refuse')) {
    return { isPass: null, detail: { skipped: true } }
  }

  const mounted = mountAccessory({
    client,
    partitionId: partition.id,
    displayName: partition.attributes.description ?? partition.id,
    isBypassAllowed: false,
    openContacts,
    disarmAfter,
  })
  mounted.accessory.update(partition)

  const startedAt = Date.now()
  const result = await writeTarget(mounted.service, HomeKitSecurityTarget.STAY_ARM)
  reportLog(mounted.log, startedAt)

  const wasRefused = !result.accepted
  const wasFast = result.elapsedMs < 5_000
  const sentNothing = mounted.sent.length === 0

  stdout.write(`\n  refused         ${wasRefused}\n`)
  stdout.write(`  took            ${(result.elapsedMs / 1000).toFixed(1)}s\n`)
  stdout.write(`  commands sent   ${mounted.sent.length}\n`)

  return {
    isPass: verdict(
      wasRefused && wasFast && sentNothing,
      wasRefused && wasFast && sentNothing
        ? 'refused immediately without touching the panel'
        : 'did not refuse cleanly; see the counts above',
    ),
    detail: { result, sent: mounted.sent.length, log: mounted.log.entries },
  }
}

/**
 * Scenario: bypass on, so the same open contact must not stop the arm.
 *
 * The two halves of the bypass decision disagreeing is what reinstated the
 * sixty-second hang, so this checks both that the flag went out and that the
 * refusal stayed out of the way.
 */
async function probeBypass({ client, partition, openContacts, disarmAfter }) {
  stdout.write('\n── Bypass: bypass on, a contact open ──\n')
  stdout.write(`  open contacts   ${openContacts.join(', ')}\n`)
  stdout.write('  expected        forceBypass sent, panel arms, one confirmation line\n')
  stdout.write('  This really arms your panel. It is disarmed again afterwards.\n')

  if (!await confirmPhrase('Arm the panel now?', 'armStay')) {
    return { isPass: null, detail: { skipped: true } }
  }

  const mounted = mountAccessory({
    client,
    partitionId: partition.id,
    displayName: partition.attributes.description ?? partition.id,
    isBypassAllowed: true,
    openContacts,
    disarmAfter,
  })
  mounted.accessory.update(partition)

  const startedAt = Date.now()
  const watcher = watchPartitionStates(client, partition.id, startedAt)
  disarmAfter.armed = true
  const result = await writeTarget(mounted.service, HomeKitSecurityTarget.STAY_ARM)

  // The write returns at the HAP deadline while the command runs on. The
  // confirmation is the line worth reading, and it arrives around 20s in.
  await sleep(30_000)
  await watcher.stop()

  reportLog(mounted.log, startedAt)
  reportStateTimeline(watcher.samples)

  const sentBypass = mounted.sent[0]?.options?.forceBypass === true
  const errors = mounted.log.entries.filter((entry) => entry.level === 'error')
  const confirmations = mounted.log.entries.filter((entry) => entry.text.includes('confirmed by the panel'))

  stdout.write(`\n  forceBypass sent  ${sentBypass}\n`)
  stdout.write(`  errors            ${errors.length}\n`)
  stdout.write(`  confirmations     ${confirmations.length}\n`)

  return {
    isPass: verdict(
      sentBypass && errors.length === 0 && confirmations.length === 1,
      sentBypass && errors.length === 0 && confirmations.length === 1
        ? 'armed over the open contact with one clean confirmation'
        : 'the bypass path did not behave; see the counts above',
    ),
    detail: { result, sent: mounted.sent, log: mounted.log.entries },
  }
}

/**
 * Scenario: a second command while the first is still running.
 *
 * The arm is deliberately left in flight. Before the sequence token existed,
 * the arm finishing would clear the pending disarm and log an error about a
 * request the user had already replaced.
 */
async function probeSupersede({ client, partition, openContacts, waitSeconds, disarmAfter }) {
  stdout.write('\n── Supersede: disarm sent while the arm is still running ──\n')
  stdout.write(`  plan            arm away, wait ${waitSeconds}s, disarm\n`)
  stdout.write(`  HAP deadline    ${settings.PARTITION_COMMAND_DEADLINE_MS / 1000}s, so the arm is still in flight\n`)
  stdout.write('  expected        no error for the arm, one confirmation for the disarm\n')
  stdout.write('  This really arms your panel. It is disarmed again afterwards.\n')

  if (!await confirmPhrase('Arm the panel now?', 'arm my house')) {
    return { isPass: null, detail: { skipped: true } }
  }

  const mounted = mountAccessory({
    client,
    partitionId: partition.id,
    displayName: partition.attributes.description ?? partition.id,
    isBypassAllowed: true,
    openContacts,
    disarmAfter,
  })
  mounted.accessory.update(partition)

  const startedAt = Date.now()
  const watcher = watchPartitionStates(client, partition.id, startedAt)
  disarmAfter.armed = true
  await writeTarget(mounted.service, HomeKitSecurityTarget.AWAY_ARM)
  await sleep(waitSeconds * 1_000 - (Date.now() - startedAt))
  await writeTarget(mounted.service, HomeKitSecurityTarget.DISARM)

  // Two waits, in order, because either alone reports too early. The held
  // disarm is not even sent until the arm finishes, so the log line comes
  // first; the panel then takes several more seconds to act on it.
  // Says "then" because the accessory's log is replayed once the waits finish,
  // timestamped from the start. Without that it reads as though everything
  // happened at the moment the waiting line was printed.
  stdout.write('\n  waiting for both commands and the panel to finish (about a minute),\n')
  stdout.write('  then printing what happened, timed from the start\n')
  const isDisarmReported = await waitForLogLine(mounted.log, 'Disarmed, accepted in', 150_000)
  const isQuiet = await waitForPanelToSettle(watcher, { quietMs: 15_000, timeoutMs: 90_000 })
  const isSettled = isDisarmReported && isQuiet
  await watcher.stop()

  reportLog(mounted.log, startedAt)
  // The panel's own account of the window, printed next to the accessory's, so
  // the two can be compared rather than one being taken on trust.
  reportStateTimeline(watcher.samples)

  const stateAfter = watcher.samples[watcher.samples.length - 1]?.state
  const everLeftDisarmed = watcher.samples.some(
    (sample) => sample.state !== PartitionState.DISARMED
      || sample.desiredState !== PartitionState.DISARMED,
  )
  // No refresh assertion. The superseded branch deliberately does not read any
  // more: the held command is sent straight after and reads back itself. Timing
  // a refresh against the superseded line only ever caught that command's own
  // read, which is true no matter what the branch under test does.

  const errors = mounted.log.entries.filter((entry) => entry.level === 'error')
  const superseded = mounted.log.entries.filter((entry) => entry.text.includes('superseded'))
  const disarmConfirmed = mounted.log.entries.some(
    (entry) => entry.text.includes('Disarmed, accepted in'),
  )

  stdout.write(`\n  errors             ${errors.length}\n`)
  stdout.write(`  superseded notices ${superseded.length}\n`)
  stdout.write(`  disarm confirmed   ${disarmConfirmed}\n`)
  stdout.write(`  panel state at end ${stateAfter}${isSettled ? '' : ' (never settled; timed out)'}\n`)
  stdout.write(`  armed on the way   ${everLeftDisarmed}`)
  // Expected now, and not a failure. Commands are sent one at a time, so the
  // arm runs to completion before the disarm that countermands it goes out.
  // The panel really does arm and then disarm; what matters is where it stops.
  stdout.write(everLeftDisarmed
    ? '  <- expected: the arm completes before the held disarm is sent\n'
    : '  <- the arm never reached the panel\n')

  // What the user asked for last was Disarmed, so the only acceptable ending
  // is a disarmed panel. This was computed, printed in capitals, and then left
  // out of the verdict, which is how a run that ended with the panel ARMED
  // while HomeKit had been told "Disarmed, confirmed" was reported as PASS.
  const isPanelWhereAsked = isSettled && stateAfter === PartitionState.DISARMED
  const isReportedHonestly = errors.length === 0
    && superseded.length === 1
    && disarmConfirmed
  const isPass = isPanelWhereAsked && isReportedHonestly

  let summary
  if (isPass) {
    summary = 'the panel ended disarmed, where it was last told to be'
  } else if (!isPanelWhereAsked) {
    summary = 'THE PANEL DID NOT END DISARMED. Alarm.com applied the abandoned arm '
      + 'after the disarm the user asked for last'
  } else {
    summary = 'the panel ended correctly but the reporting did not; see the counts above'
  }

  return {
    isPass: verdict(isPass, summary),
    detail: {
      errors,
      superseded,
      disarmConfirmed,
      stateAfter,
      everLeftDisarmed,
      samples: watcher.samples,
      refreshes: mounted.refreshes.length,
      log: mounted.log.entries,
    },
  }
}

/** Names of contacts a live read says are open, matching the platform's rule. */
function openContactNames(sensors, partitionCount) {
  // The real one gives up on multi-partition systems, because it cannot tell
  // which partition a sensor belongs to. Without this the stub hands over a
  // list the shipping plugin would never produce, and --refusal reports PASS
  // for a refusal that would not happen in a real install — the exact "agrees
  // with a bug rather than catching it" failure this script exists to avoid.
  if (partitionCount !== 1) {
    return []
  }

  return sensors
    .filter((sensor) => {
      const mapped = mappers.toHomeKitSensorState(sensor.attributes)
      return mapped?.kind === 'contact' && mapped.isTriggered === true
    })
    .map((sensor) => String(sensor.attributes.description ?? `Sensor ${sensor.id}`))
    .sort()
}

/** Which scenarios this run should attempt. */
function selectScenarios() {
  const isAll = hasFlag('--all')
  return {
    night: hasFlag('--night-display') || isAll,
    refusal: hasFlag('--refusal') || isAll,
    bypass: hasFlag('--bypass') || isAll,
    supersede: hasFlag('--supersede') || isAll,
    waitSeconds: readNumericFlag('--wait', { fallback: 12, min: 10, max: 55 }),
  }
}

/** Sign in and read the account, using the shipping code throughout. */
async function connect() {
  const log = createTerminalLogger('probe-accessory', hasFlag('--verbose'))
  const credentials = await resolveCredentials()

  stdout.write('\n── Sign-in (via dist/) ──\n')
  const sessionManager = new SessionManager({
    credentials: {
      username: credentials.username,
      password: credentials.password,
      twoFactorAuthenticationId: credentials.mfaToken ?? '',
    },
    authIntervalMinutes: 10,
    log,
  })
  const client = new AlarmComClient({ sessionManager, log })

  stdout.write('\n── Discovery ──\n')
  const systemId = await client.getSystemId()
  const devices = await client.getSystemDevices(systemId)
  const [partition] = await client.getPartitions(devices.partitionIds)
  const sensors = await client.getSensors(devices.sensorIds)

  if (!partition) {
    throw new Error('No partition found on this account.')
  }

  return { client, partition, sensors, partitionCount: devices.partitionIds.length }
}

function reportDiscovery({ partition, partitionCount, openContacts }) {
  if (partitionCount !== 1) {
    stdout.write(`  NOTE: ${partitionCount} partitions. The refusal check is deliberately\n`)
    stdout.write('        disabled on multi-partition systems, so --refusal cannot prove\n')
    stdout.write('        anything here.\n')
  }

  stdout.write(`  partition       ${partition.attributes.description} (${partition.id})\n`)
  stdout.write(`  state           ${partition.attributes.state}\n`)
  stdout.write(`  can command     ${partition.attributes.hasPermissionToChangeState}\n`)
  stdout.write(`  open contacts   ${openContacts.length ? openContacts.join(', ') : '(none)'}\n`)
}

async function main() {
  const scenarios = selectScenarios()
  const { night: wantsNight, refusal: wantsRefusal } = scenarios
  const { bypass: wantsBypass, supersede: wantsSupersede, waitSeconds } = scenarios

  if (!wantsNight && !wantsRefusal && !wantsBypass && !wantsSupersede) {
    stdout.write('Nothing to do. Pass a scenario, or --help. Start with --night-display.\n')
    return
  }

  const { client, partition, sensors, partitionCount } = await connect()
  const openContacts = openContactNames(sensors, partitionCount)
  reportDiscovery({ partition, partitionCount, openContacts })

  // Refuse to run against a panel somebody armed on purpose. The cleanup
  // disarms unconditionally, so starting from armed means the tool unarms a
  // house and then reports success. Every arming scenario also assumes a
  // disarmed start; from armed, the arm is a no-op that confirms inside the
  // deadline and --supersede fails for a reason that has nothing to do with
  // the code under test.
  const isArmingScenario = wantsRefusal || wantsBypass || wantsSupersede
  if (isArmingScenario && partition.attributes.state !== PartitionState.DISARMED) {
    stdout.write(`\n  The panel is in state ${partition.attributes.state}, not disarmed.\n`)
    stdout.write('  Refusing to run: this would disarm a panel you armed deliberately.\n')
    return
  }

  const needsOpenContact = wantsRefusal || wantsBypass
  if (needsOpenContact && openContacts.length === 0) {
    stdout.write('\n  Open a contact sensor first. With everything shut, neither the\n')
    stdout.write('  refusal nor the bypass scenario can show anything.\n')
    if (!wantsSupersede && !wantsNight) {return}
  }

  const results = {}
  // Armed inside the commandPartition wrapper, so it is set the instant a
  // command really leaves rather than wherever someone remembered to set it.
  const disarmAfter = { armed: false }
  let isCleaningUp = false

  /**
   * Return the panel to disarmed, and confirm it rather than assume it.
   *
   * The flag is cleared only once a read agrees, because clearing it up front
   * meant a single transient failure permanently disabled both this and the
   * interrupt handler, leaving a printed sentence as the only safeguard on a
   * live security panel.
   */
  const putItBack = async () => {
    if (!disarmAfter.armed || isCleaningUp) {return}
    isCleaningUp = true
    stdout.write('\n── Putting it back ──\n')

    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await client.commandPartition(partition.id, 'disarm', { nightArming: false, forceBypass: false })
        } catch (error) {
          stdout.write(`  disarm attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}\n`)
        }

        // Read until it stops moving, not once. A single read lands inside the
        // several seconds the panel takes to act, so it returns the state from
        // before the command — which is how a run once reported a disarmed
        // panel and then armed itself after the script had exited.
        const state = await readUntilSettled(client, partition.id)
        stdout.write(`  state after attempt ${attempt}: ${state}\n`)

        if (state === PartitionState.DISARMED) {
          disarmAfter.armed = false
          return
        }
      }

      stdout.write('\n  COULD NOT DISARM. The panel may still be armed.\n')
      stdout.write('  Disarm at the keypad or in the Alarm.com app now.\n')
    } finally {
      isCleaningUp = false
    }
  }

  // A second interrupt must not cut short the disarm the first one started.
  process.on('SIGINT', () => {
    if (isCleaningUp) {
      stdout.write('\n  Still disarming — interrupt again only if you will disarm by hand.\n')
      return
    }
    void putItBack().then(() => process.exit(130))
  })

  try {
    if (wantsNight) {results.night = probeNightDisplay(partition)}
    if (wantsRefusal && openContacts.length > 0) {
      results.refusal = await probeRefusal({ client, partition, openContacts, disarmAfter })
      // Runs even though a correct refusal sends nothing. The scenario exists
      // to catch a regression, and the regression it catches arms the panel.
      await putItBack()
    }
    if (wantsBypass && openContacts.length > 0) {
      results.bypass = await probeBypass({ client, partition, openContacts, disarmAfter })
      await putItBack()
    }
    if (wantsSupersede) {
      results.supersede = await probeSupersede({
        client, partition, openContacts, waitSeconds, disarmAfter,
      })
      await putItBack()
    }
  } finally {
    await putItBack()
  }

  stdout.write('\n── Summary ──\n')
  for (const [name, outcome] of Object.entries(results)) {
    const label = outcome.isPass === null ? 'SKIP' : outcome.isPass ? 'PASS' : 'FAIL'
    stdout.write(`  ${label}  ${name}\n`)
  }

  const reportDir = join(DIST_DIR, '..', 'probe-output')
  await mkdir(reportDir, { recursive: true })
  const path = join(reportDir, `accessory-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  await writeFile(path, redactFreeText(JSON.stringify(results, null, 2)))
  stdout.write(`\n  Scrubbed report written to ${path}\n`)
}

// Exported so the waiting helpers can be rehearsed against a fake panel rather
// than against a real one. Three live runs were spent on helpers that returned
// too early, one of which left the panel arming after the script had exited.
export { readUntilSettled, waitForLogLine, waitForPanelToSettle }

// Only when run directly, so importing this file to test those helpers does not
// try to sign in to Alarm.com.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    stdout.write(`\nFailed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
