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
function mountAccessory({ client, partitionId, displayName, isBypassAllowed, openContacts }) {
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
        return client.commandPartition(id, action, options)
      },
    },
    requestDeviceRefresh: (id) => refreshes.push(id),
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
async function probeRefusal({ client, partition, openContacts }) {
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
  })
  mounted.accessory.update(partition)

  const startedAt = Date.now()
  disarmAfter.armed = true
  const result = await writeTarget(mounted.service, HomeKitSecurityTarget.STAY_ARM)

  // The write returns at the HAP deadline while the command runs on. The
  // confirmation is the line worth reading, and it arrives around 20s in.
  await sleep(30_000)
  reportLog(mounted.log, startedAt)

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
  })
  mounted.accessory.update(partition)

  const startedAt = Date.now()
  disarmAfter.armed = true
  await writeTarget(mounted.service, HomeKitSecurityTarget.AWAY_ARM)
  await sleep(waitSeconds * 1_000 - (Date.now() - startedAt))
  await writeTarget(mounted.service, HomeKitSecurityTarget.DISARM)

  // Both commands have to finish before the evidence is complete.
  await sleep(40_000)
  reportLog(mounted.log, startedAt)

  const errors = mounted.log.entries.filter((entry) => entry.level === 'error')
  const superseded = mounted.log.entries.filter((entry) => entry.text.includes('superseded'))
  const disarmConfirmed = mounted.log.entries.some(
    (entry) => entry.text.includes('Disarmed, confirmed by the panel'),
  )

  stdout.write(`\n  errors             ${errors.length}\n`)
  stdout.write(`  superseded notices ${superseded.length}\n`)
  stdout.write(`  disarm confirmed   ${disarmConfirmed}\n`)

  return {
    isPass: verdict(
      errors.length === 0 && superseded.length === 1 && disarmConfirmed,
      errors.length === 0 && superseded.length === 1 && disarmConfirmed
        ? 'the abandoned arm kept quiet and the disarm was reported cleanly'
        : 'the superseded command interfered; see the counts above',
    ),
    detail: { errors, superseded, disarmConfirmed, log: mounted.log.entries },
  }
}

/** Names of contacts a live read says are open, matching the platform's rule. */
function openContactNames(sensors) {
  return sensors
    .filter((sensor) => {
      const mapped = mappers.toHomeKitSensorState(sensor.attributes)
      return mapped?.kind === 'contact' && mapped.isTriggered === true
    })
    .map((sensor) => String(sensor.attributes.description))
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
  const openContacts = openContactNames(sensors)
  reportDiscovery({ partition, partitionCount, openContacts })

  const needsOpenContact = wantsRefusal || wantsBypass
  if (needsOpenContact && openContacts.length === 0) {
    stdout.write('\n  Open a contact sensor first. With everything shut, neither the\n')
    stdout.write('  refusal nor the bypass scenario can show anything.\n')
    if (!wantsSupersede && !wantsNight) {return}
  }

  const results = {}
  // Set the moment an arm goes out, so the cleanup runs even if the assertions
  // below never do.
  const disarmAfter = { armed: false }

  const putItBack = async () => {
    if (!disarmAfter.armed) {return}
    disarmAfter.armed = false
    stdout.write('\n── Putting it back ──\n')
    try {
      await client.commandPartition(partition.id, 'disarm', { nightArming: false, forceBypass: false })
      const [after] = await client.getPartitions([partition.id])
      stdout.write(`  final state ${after?.attributes?.state}\n`)
    } catch (error) {
      stdout.write(`  DISARM FAILED: ${error instanceof Error ? error.message : String(error)}\n`)
      stdout.write('  Disarm at the keypad or in the Alarm.com app.\n')
    }
  }

  process.on('SIGINT', () => { void putItBack().then(() => process.exit(130)) })

  try {
    if (wantsNight) {results.night = probeNightDisplay(partition)}
    if (wantsRefusal && openContacts.length > 0) {
      results.refusal = await probeRefusal({ client, partition, openContacts })
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

main().catch((error) => {
  stdout.write(`\nFailed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
