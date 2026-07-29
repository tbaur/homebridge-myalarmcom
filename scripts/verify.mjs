#!/usr/bin/env node
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Live end-to-end check of the compiled plugin against a real account.
 *
 * Unlike `probe.mjs`, which reimplements the protocol to discover it, this
 * drives the actual code in `dist/`. That is the point: it verifies the thing
 * that ships, so a mapping bug shows up here rather than in someone's Home app.
 *
 * Run `npm run build` first.
 *
 * Usage:
 *   node scripts/verify.mjs                  discover, show mapped state, listen 90s
 *   node scripts/verify.mjs --listen 300     listen longer, e.g. while walking the house
 *   node scripts/verify.mjs --arm stay       send one arming command (guarded)
 *   node scripts/verify.mjs --arm-cycle      arm stay, watch it settle, then disarm
 *
 * Everything except --arm and --arm-cycle is read-only. Both really do command
 * the panel, both require a typed confirmation, and --arm-cycle always attempts
 * a disarm on its way out, including after an interrupt.
 *
 * The output contains your device names and current door/window states. Treat
 * it as sensitive; it is a floor plan of your house with the doors labelled.
 */

import { createRequire } from 'node:module'
import { stdout } from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

import { confirmPhrase, resolveCredentials } from './lib/prompt.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const distDir = join(here, '..', 'dist')
const require = createRequire(import.meta.url)

if (!existsSync(join(distDir, 'index.js'))) {
  stdout.write('dist/ is missing. Run "npm run build" first.\n')
  process.exit(1)
}

const { SessionManager } = require(join(distDir, 'api/session-manager.js'))
const { AlarmComClient } = require(join(distDir, 'api/client.js'))
const { EventStream } = require(join(distDir, 'api/event-stream.js'))
const mappers = require(join(distDir, 'utils/mappers.js'))
const alarmTypes = require(join(distDir, 'types/alarm.js'))
const events = require(join(distDir, 'types/events.js'))

/** Console-backed logger matching the interface the plugin expects. */
const createLogger = (isVerbose) => ({
  debug: (message) => {
    if (isVerbose) {
      stdout.write(`  · ${message}\n`)
    }
  },
  info: (message) => stdout.write(`  · ${message}\n`),
  warn: (message) => stdout.write(`  ! ${message}\n`),
  error: (message) => stdout.write(`  ✗ ${message}\n`),
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readFlag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

/** Reverse an enum object into value -> name, for readable output. */
function nameOf(enumObject, value) {
  return Object.keys(enumObject).find((key) => enumObject[key] === value) ?? String(value)
}

const ARMING_MODIFIER_NAMES = {
  0: 'bypassSensors',
  1: 'noEntryDelay',
  2: 'silentArming',
  3: 'nightArming',
  4: 'selectivelyBypassSensors',
  5: 'forceArm',
}

function describeArmingOptions(options) {
  if (!options) {
    return '(none reported)'
  }
  return Object.entries(options)
    .map(([mode, codes]) => {
      const names = (codes ?? []).map((code) => ARMING_MODIFIER_NAMES[code] ?? `code ${code}`)
      return `${mode}: ${names.length ? names.join(', ') : '(no modifiers)'}`
    })
    .join('\n      ')
}

function reportPartition(resource) {
  const attributes = resource.attributes
  const displayed = mappers.toDisplayedSecurityState(attributes)

  stdout.write(`\n  ${attributes.description ?? resource.id}  (${resource.id})\n`)
  stdout.write(`    alarm.com state    ${attributes.state} (${nameOf(alarmTypes.PartitionState, attributes.state)})\n`)
  stdout.write(`    hasActiveAlarm     ${attributes.hasActiveAlarm}\n`)
  stdout.write(`    -> HomeKit         ${displayed} (${nameOf(mappers.HomeKitSecurityState, displayed)})\n`)
  stdout.write(`    can change state   ${attributes.hasPermissionToChangeState}\n`)
  stdout.write(`    night arming       ${alarmTypes.supportsNightArming(attributes)}\n`)
  stdout.write(`    arming options     ${describeArmingOptions(attributes.extendedArmingOptions)}\n`)
}

function reportSensor(resource) {
  const attributes = resource.attributes
  const mapped = mappers.toHomeKitSensorState(attributes)

  if (!mapped) {
    stdout.write(`    ${resource.id.padEnd(14)} ${String(attributes.description).padEnd(24)} SKIPPED (device type ${attributes.deviceType})\n`)
    return
  }

  const flags = [
    mapped.isAmbiguous ? 'AMBIGUOUS' : null,
    attributes.isMonitoringEnabled === false ? 'unmonitored' : null,
    attributes.isMalfunctioning ? 'malfunctioning' : null,
  ].filter(Boolean).join(' ')

  stdout.write(
    `    ${resource.id.padEnd(14)} ${String(attributes.description).padEnd(24)}`
      + ` ${mapped.kind.padEnd(7)} state=${attributes.state} ocs=${attributes.openClosedStatus}`
      + ` -> ${String(mapped.value).padEnd(5)} "${mapped.label}" ${flags}\n`,
  )
}

/** Poll a partition until it satisfies a predicate, reporting each change. */
async function watchPartition(client, partitionId, isDone, timeoutMs) {
  const startedAt = Date.now()
  let lastSeen = null

  while (Date.now() - startedAt < timeoutMs) {
    const [resource] = await client.getPartitions([partitionId])
    const attributes = resource?.attributes ?? {}
    const signature = `${attributes.state}/${attributes.desiredState}/${attributes.hasActiveAlarm}`

    if (signature !== lastSeen) {
      lastSeen = signature
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
      stdout.write(
        `    +${seconds.padStart(5)}s  state=${attributes.state} (${nameOf(alarmTypes.PartitionState, attributes.state)})`
          + `  desired=${attributes.desiredState}  alarm=${attributes.hasActiveAlarm}`
          + `  -> HomeKit ${nameOf(mappers.HomeKitSecurityState, mappers.toDisplayedSecurityState(attributes))}\n`,
      )
    }

    if (isDone(attributes)) {
      return attributes
    }

    await sleep(5000)
  }

  stdout.write(`    timed out after ${timeoutMs / 1000}s\n`)
  return null
}

/** Send one command and report precisely how Alarm.com answered. */
async function sendCommand(client, partitionId, action) {
  try {
    const result = await client.commandPartition(partitionId, action, {})
    stdout.write(`  ACCEPTED. Immediate response state=${result?.attributes?.state}, desired=${result?.attributes?.desiredState}\n`)
    return true
  } catch (error) {
    stdout.write(`  REFUSED: ${error?.constructor?.name ?? 'Error'}\n`)
    stdout.write(`    code       ${error?.code ?? '(none)'}\n`)
    stdout.write(`    httpStatus ${error?.httpStatus ?? '(none)'}\n`)
    stdout.write(`    message    ${error?.message}\n`)
    return false
  }
}

/**
 * Arm the panel, observe it settle, then disarm it again.
 *
 * Disarming is automatic rather than prompted, and also runs if the arm times
 * out or the operator interrupts. Leaving someone's house armed because a
 * development script exited badly is not an acceptable outcome, so the armed
 * window is kept as short as the panel allows.
 */
async function armCycle(client, partition) {
  const partitionId = partition.id
  const name = partition.attributes.description ?? partitionId

  stdout.write('\n── Arm / disarm cycle ──\n')
  stdout.write(`  This will really arm "${name}" in STAY mode, then disarm it.\n`)
  stdout.write('  Stay where you are while it runs, and have the Alarm.com app to hand.\n')
  stdout.write('  Interrupting with Ctrl-C will still attempt a disarm.\n')

  const confirmed = await confirmPhrase('  This affects a live security system.', 'arm my house')
  if (!confirmed) {
    stdout.write('  Skipped.\n')
    return
  }

  let isArmed = false
  const disarm = async () => {
    stdout.write('\n  Disarming...\n')
    if (await sendCommand(client, partitionId, 'disarm')) {
      await watchPartition(
        client,
        partitionId,
        (a) => a.state === alarmTypes.PartitionState.DISARMED,
        90_000,
      )
    }
  }

  const onInterrupt = () => {
    stdout.write('\n  Interrupted. Attempting disarm before exit.\n')
    disarm().finally(() => process.exit(1))
  }
  process.once('SIGINT', onInterrupt)

  try {
    stdout.write('\n  Arming (stay)...\n')
    if (await sendCommand(client, partitionId, 'armStay')) {
      isArmed = true
      const settled = await watchPartition(
        client,
        partitionId,
        (a) => a.state === alarmTypes.PartitionState.ARMED_STAY,
        90_000,
      )
      if (settled) {
        stdout.write('  Panel reached ARMED_STAY.\n')
      }
    }
  } finally {
    process.removeListener('SIGINT', onInterrupt)
    if (isArmed) {
      await disarm()
    }
  }
}

/**
 * Attempt an arming command and report exactly what Alarm.com says.
 *
 * On a read-only account this is expected to be refused, and the refusal is
 * itself the useful result: it pins down the error shape so the plugin can
 * handle it precisely instead of guessing.
 */
async function attemptArm(client, partition, mode) {
  const action = mode === 'disarm' ? 'disarm' : mode === 'away' ? 'armAway' : 'armStay'
  const name = partition.attributes.description ?? partition.id

  stdout.write('\n── Arming attempt ──\n')

  if (partition.attributes.hasPermissionToChangeState === false) {
    stdout.write('  This account reports hasPermissionToChangeState=false, so this should be refused.\n')
    stdout.write('  Sending it anyway records the exact rejection, which is the point of the exercise.\n')
  } else {
    stdout.write(`  WARNING: this account CAN change state. This will really ${action} "${name}".\n`)
  }

  const confirmed = await confirmPhrase(`  About to send "${action}" to "${name}".`, action)
  if (!confirmed) {
    stdout.write('  Skipped.\n')
    return
  }

  try {
    const result = await client.commandPartition(partition.id, action, {})
    stdout.write(`  ACCEPTED. Panel reports state ${result?.attributes?.state}.\n`)
    stdout.write('  Arming takes 20-30s to settle; watch the events below.\n')
  } catch (error) {
    stdout.write(`  REFUSED: ${error?.constructor?.name ?? 'Error'}\n`)
    stdout.write(`    code       ${error?.code ?? '(none)'}\n`)
    stdout.write(`    httpStatus ${error?.httpStatus ?? '(none)'}\n`)
    stdout.write(`    message    ${error?.message}\n`)
  }
}

/**
 * Begin listening for pushed events, printing each with its resolved state.
 *
 * Returned as a handle rather than a fixed-duration call so the arm/disarm
 * cycle can run with the stream already live and capture the partition events
 * the panel emits as it changes state.
 */
async function startListening(client, context, log) {
  const { namesById, partitionIds, kindsById } = context
  let eventCount = 0

  const describeAfterEvent = async (deviceId) => {
    if (partitionIds.has(deviceId)) {
      const [resource] = await client.getPartitions([deviceId])
      const state = resource?.attributes?.state
      const displayed = mappers.toDisplayedSecurityState(resource?.attributes ?? {})
      stdout.write(`              -> now ${state} (${nameOf(alarmTypes.PartitionState, state)}), HomeKit ${nameOf(mappers.HomeKitSecurityState, displayed)}\n`)
      return
    }

    const [resource] = await client.getSensors([deviceId])
    if (resource) {
      const mapped = mappers.toHomeKitSensorState(resource.attributes)
      stdout.write(`              -> now "${mapped?.label}" (HomeKit ${String(mapped?.value)})\n`)
    }
  }

  const stream = new EventStream({
    log,
    requestToken: () => client.getEventStreamToken(),
    onDeviceEvent: (deviceId, event) => {
      eventCount++
      const name = namesById.get(deviceId) ?? '(unknown device)'
      const at = new Date().toLocaleTimeString()
      stdout.write(`  ${at}  ${deviceId.padEnd(14)} ${name.padEnd(24)} EventType=${event.EventType} DeviceType=${event.DeviceType}\n`)

      // Show what the plugin would decide immediately from the event alone,
      // separately from the confirming re-read, so the two are distinguishable.
      const hint = events.readSensorEventHint(event, kindsById.get(deviceId))
      if (hint) {
        stdout.write(`              -> event alone implies ${hint.isTriggered ? 'TRIGGERED' : 'at rest'}${hint.isTransient ? ' (momentary)' : ''}\n`)
      }

      void describeAfterEvent(deviceId).catch(() => undefined)
    },
    onUnavailable: () => stdout.write('  Event stream gave up; polling would take over.\n'),
  })

  await stream.start()

  return {
    stop: () => {
      stream.stop()
      return eventCount
    },
  }
}

/** Listen for a fixed window, then report what was seen. */
async function listen(client, seconds, context, log) {
  stdout.write(`\n── Listening ${seconds}s for events ──\n`)
  stdout.write('  Walk past a motion sensor, open a door. Ctrl-C to stop early.\n\n')

  const handle = await startListening(client, context, log)
  await sleep(seconds * 1000)
  const eventCount = handle.stop()

  stdout.write(`\n  Captured ${eventCount} device event(s).\n`)
  if (eventCount === 0) {
    stdout.write('  None seen. Either nothing moved, or the stream did not connect (retry with --verbose).\n')
  }
}

async function main() {
  const listenSeconds = Number(readFlag('listen', '90'))
  const armMode = readFlag('arm', null)
  const isArmCycle = process.argv.includes('--arm-cycle')
  const isVerbose = process.argv.includes('--verbose')
  const log = createLogger(isVerbose)

  if (armMode && !['stay', 'away', 'disarm'].includes(armMode)) {
    throw new Error('--arm accepts "stay", "away", or "disarm"')
  }

  const credentials = await resolveCredentials()

  stdout.write('\n── Sign-in (via dist/api/auth.js) ──\n')
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
  stdout.write(`  system ${systemId}: ${devices.partitionIds.length} partition(s), ${devices.sensorIds.length} sensor(s)\n`)

  const partitions = await client.getPartitions(devices.partitionIds)
  const sensors = await client.getSensors(devices.sensorIds)

  stdout.write('\n── Partitions ──')
  for (const partition of partitions) {
    reportPartition(partition)
  }

  stdout.write('\n── Sensors ──\n')
  for (const sensor of sensors) {
    reportSensor(sensor)
  }

  const ambiguous = sensors.filter((s) => mappers.toHomeKitSensorState(s.attributes)?.isAmbiguous)
  if (ambiguous.length > 0) {
    stdout.write(`\n  ${ambiguous.length} sensor(s) reported an ambiguous state. Please report these.\n`)
  }

  const context = {
    namesById: new Map([
      ...sensors.map((s) => [s.id, s.attributes.description]),
      ...partitions.map((p) => [p.id, p.attributes.description ?? 'Partition']),
    ]),
    partitionIds: new Set(partitions.map((p) => p.id)),
    // Resolved from discovery, not from the event frame, which misreports it.
    kindsById: new Map(sensors.map((s) => [s.id, mappers.toSensorServiceKind(s.attributes.deviceType)])),
  }

  if (isArmCycle && partitions[0]) {
    // Stream first, so the panel's own state-change events are captured as the
    // cycle runs rather than being missed while it settles.
    const handle = await startListening(client, context, log)
    try {
      await armCycle(client, partitions[0])
    } finally {
      handle.stop()
    }
  } else if (armMode && partitions[0]) {
    await attemptArm(client, partitions[0], armMode)
  }

  if (listenSeconds > 0) {
    await listen(client, listenSeconds, context, log)
  }

  stdout.write('\nDone.\n')
  process.exit(0)
}

main().catch((error) => {
  stdout.write(`\nFailed: ${error?.message ?? error}\n`)
  process.exit(1)
})
