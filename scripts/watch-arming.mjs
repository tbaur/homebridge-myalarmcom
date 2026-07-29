#!/usr/bin/env node
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Passively record what the panel does while you arm it yourself.
 *
 * This script sends no commands. It signs in, watches, and writes down what it
 * sees, so you can arm and disarm from the Alarm.com app while it captures the
 * state transitions and push events the plugin will have to handle.
 *
 * It diffs the whole partition attribute object rather than a list of fields
 * chosen in advance, because the useful discovery here is the attribute nobody
 * thought to look for.
 *
 * Run `npm run build` first.
 *
 * Usage:
 *   node scripts/watch-arming.mjs              watch until Ctrl-C
 *   node scripts/watch-arming.mjs --minutes 5  stop on its own after 5 minutes
 *
 * A scrubbed timeline is written to probe-output/, which is never committed.
 * The console output is NOT scrubbed and names your devices; treat it as
 * sensitive if you paste it anywhere.
 */

import { createRequire } from 'node:module'
import { stdout } from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

import { resolveCredentials } from './lib/prompt.mjs'
import { createScrubber } from './lib/scrub.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const distDir = join(here, '..', 'dist')
const outputDir = join(here, '..', 'probe-output')
const require = createRequire(import.meta.url)

if (!existsSync(join(distDir, 'index.js'))) {
  stdout.write('dist/ is missing. Run "npm run build" first.\n')
  process.exit(1)
}

const { SessionManager } = require(join(distDir, 'api/session-manager.js'))
const { AlarmComClient } = require(join(distDir, 'api/client.js'))
const { EventStream } = require(join(distDir, 'api/event-stream.js'))
const { httpRequest } = require(join(distDir, 'api/http.js'))
const mappers = require(join(distDir, 'utils/mappers.js'))
const alarmTypes = require(join(distDir, 'types/alarm.js'))
const settings = require(join(distDir, 'settings.js'))

/**
 * Polling cadence.
 *
 * Twenty requests a minute against the client's own sixty-per-minute ceiling.
 * Fast enough to catch a transitional `desiredState`, slow enough that it does
 * not look like a scraper to an account that locks out for exactly that.
 */
const POLL_INTERVAL_MS = 3_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readFlag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

function nameOf(enumObject, value) {
  return Object.keys(enumObject).find((key) => enumObject[key] === value) ?? String(value)
}

const elapsed = (startedAt) => `${((Date.now() - startedAt) / 1000).toFixed(1).padStart(6)}s`

/**
 * Report every attribute that changed between two readings.
 *
 * Deliberately generic. Naming the interesting fields up front would hide the
 * ones this run exists to discover.
 */
function diffAttributes(before, after) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  const changes = []

  for (const key of keys) {
    // Compared as JSON but recorded raw. Stringifying here hid the values
    // inside opaque strings, which is how a real device name reached scrubbed
    // output: the scrubber saw a value under the key `from`, not under the
    // attribute name that would have told it the value was a name.
    if (JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])) {
      changes.push({ key, from: before?.[key], to: after?.[key] })
    }
  }

  return changes
}

/**
 * Ask Alarm.com the same question the client just failed on, and show the
 * unabridged answer.
 *
 * The client maps a status onto a typed error, which is right for a plugin and
 * useless for diagnosis. When discovery fails, the response body is the only
 * thing that says why, so print it verbatim.
 */
async function explainFailure(sessionManager, url) {
  stdout.write('\n── Raw response ──\n')
  stdout.write('  Re-requesting the failing URL to show exactly what Alarm.com said.\n\n')

  try {
    const session = await sessionManager.getSession()
    const response = await httpRequest(url, {
      headers: {
        Accept: 'application/vnd.api+json',
        Cookie: session.cookieHeader,
        ajaxrequestuniquekey: session.ajaxKey,
        Referer: settings.HOME_REFERER,
      },
    })

    const text = await response.text()
    stdout.write(`  HTTP ${response.status} ${response.statusText}\n`)
    stdout.write(`  content-type: ${response.headers.get('content-type')}\n\n`)
    stdout.write(`${text.slice(0, 2000)}\n`)
  } catch (error) {
    stdout.write(`  Could not re-request: ${error?.message ?? error}\n`)
  }
}

/** Sign in and resolve the partitions, explaining any failure in full. */
async function discover(client, sessionManager) {
  const systemId = await client.getSystemId()
  stdout.write(`  selected system ${systemId}\n`)

  let devices
  try {
    devices = await client.getSystemDevices(systemId)
  } catch (error) {
    stdout.write(`\n  Discovery failed: ${error?.constructor?.name}: ${error?.message}\n`)
    await explainFailure(sessionManager, `${settings.SYSTEM_URL}${encodeURIComponent(systemId)}`)
    throw error
  }

  stdout.write(`  ${devices.partitionIds.length} partition(s), ${devices.sensorIds.length} sensor(s)\n`)
  return devices
}

function describePartition(attributes) {
  return `state=${attributes.state} (${nameOf(alarmTypes.PartitionState, attributes.state)})`
    + `  desired=${attributes.desiredState}`
    + `  HomeKit=${nameOf(mappers.HomeKitSecurityState, mappers.toDisplayedSecurityState(attributes))}`
}

async function main() {
  const minutes = Number(readFlag('minutes', '0'))
  const isVerbose = process.argv.includes('--verbose')
  const timeline = []

  const log = {
    debug: (message) => isVerbose && stdout.write(`  · ${message}\n`),
    info: (message) => stdout.write(`  · ${message}\n`),
    warn: (message) => stdout.write(`  ! ${message}\n`),
    error: (message) => stdout.write(`  ✗ ${message}\n`),
  }

  const credentials = await resolveCredentials()

  stdout.write('\n── Sign-in ──\n')
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
  const devices = await discover(client, sessionManager)

  const previous = new Map()
  const namesById = new Map()

  const partitions = await client.getPartitions(devices.partitionIds)
  const sensors = await client.getSensors(devices.sensorIds)
  for (const sensor of sensors) {
    namesById.set(sensor.id, sensor.attributes.description)
    previous.set(sensor.id, sensor.attributes)
  }

  stdout.write('\n── Starting state ──\n')
  for (const partition of partitions) {
    namesById.set(partition.id, partition.attributes.description ?? 'Partition')
    previous.set(partition.id, partition.attributes)
    stdout.write(`  ${partition.attributes.description}  ${describePartition(partition.attributes)}\n`)
    stdout.write(`    can change state ${partition.attributes.hasPermissionToChangeState}\n`)
  }

  // Which sensors are already tripped matters when reading the run afterwards:
  // a zone that is open to begin with will not emit an event for being opened
  // again, and mistaking that for a missed event sends you hunting a bug that
  // is not there.
  const readingOf = ({ attributes }) => alarmTypes.readSensorState(
    attributes.deviceType,
    attributes.state,
    attributes.openClosedStatus,
  )

  const triggered = sensors.filter((sensor) => readingOf(sensor).isTriggered)
  stdout.write(`  ${sensors.length} sensor(s), ${triggered.length} already tripped\n`)
  for (const sensor of triggered) {
    stdout.write(`    ${sensor.id.padEnd(14)} ${String(sensor.attributes.description).padEnd(24)} "${readingOf(sensor).label}"\n`)
  }

  const startedAt = Date.now()

  stdout.write('\n── Watching ──\n')
  stdout.write('  Nothing is sent to your panel. Arm and disarm from your iPhone now.\n')
  stdout.write(`  Polling every ${POLL_INTERVAL_MS / 1000}s and listening for push events.\n`)
  stdout.write(`  ${minutes > 0 ? `Stops after ${minutes} minute(s), or` : 'Runs until'} Ctrl-C.\n\n`)

  // Devices that pushed an event recently, so a polled change can be told apart
  // from one the stream never announced.
  const announcedAt = new Map()

  const stream = new EventStream({
    log,
    requestToken: () => client.getEventStreamToken(),
    onDeviceEvent: (deviceId, event) => {
      const name = namesById.get(deviceId) ?? '(unknown)'
      announcedAt.set(deviceId, Date.now())
      stdout.write(
        `  ${elapsed(startedAt)}  EVENT  ${deviceId.padEnd(14)} ${String(name).padEnd(22)}`
          + ` EventType=${event.EventType} EventValue=${event.EventValue} DeviceType=${event.DeviceType}\n`,
      )
      timeline.push({ atMs: Date.now() - startedAt, kind: 'event', deviceId, event })
    },
    onUnavailable: () => stdout.write('  ! Event stream gave up; polling continues.\n'),
  })

  await stream.start()

  let isStopping = false
  const stop = () => {
    if (isStopping) {
      return
    }
    isStopping = true
    stream.stop()

    stdout.write('\n── Timeline ──\n')
    if (timeline.length === 0) {
      stdout.write('  Nothing changed while watching.\n')
    }
    for (const entry of timeline) {
      const at = `${(entry.atMs / 1000).toFixed(1).padStart(7)}s`
      if (entry.kind === 'event') {
        stdout.write(`  ${at}  event  ${entry.deviceId} EventType=${entry.event.EventType}\n`)
      } else {
        const label = entry.wasAnnounced === false ? 'UNSEEN' : 'state '
        const rendered = entry.changes
          .map((c) => `${c.key}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`)
          .join(', ')
        stdout.write(`  ${at}  ${label} ${entry.deviceId} ${rendered}\n`)
      }
    }

    const unseen = timeline.filter((entry) => entry.wasAnnounced === false)
    if (unseen.length > 0) {
      stdout.write(`\n  ${unseen.length} change(s) arrived with no event. The polling fallback is load-bearing.\n`)
    }

    mkdirSync(outputDir, { recursive: true })
    const file = join(outputDir, 'arming-timeline.json')
    writeFileSync(file, JSON.stringify(createScrubber().scrub({ timeline }), null, 2))
    stdout.write(`\n  Scrubbed timeline written to ${file}\n`)

    process.exit(0)
  }

  process.on('SIGINT', stop)

  const deadline = minutes > 0 ? Date.now() + minutes * 60_000 : Infinity

  while (Date.now() < deadline && !isStopping) {
    await sleep(POLL_INTERVAL_MS)

    let currentPartitions
    let currentSensors
    try {
      currentPartitions = await client.getPartitions(devices.partitionIds)
      currentSensors = await client.getSensors(devices.sensorIds)
    } catch (error) {
      stdout.write(`  ${elapsed(startedAt)}  poll failed: ${error?.message}\n`)
      continue
    }

    for (const partition of currentPartitions) {
      const changes = diffAttributes(previous.get(partition.id), partition.attributes)
      if (changes.length === 0) {
        continue
      }

      stdout.write(`  ${elapsed(startedAt)}  STATE  ${namesById.get(partition.id)}  ${describePartition(partition.attributes)}\n`)
      for (const change of changes) {
        stdout.write(`             ${change.key}: ${change.from} -> ${change.to}\n`)
      }

      timeline.push({ atMs: Date.now() - startedAt, kind: 'state', deviceId: partition.id, changes })
      previous.set(partition.id, partition.attributes)
    }

    for (const sensor of currentSensors) {
      const changes = diffAttributes(previous.get(sensor.id), sensor.attributes)
      if (changes.length === 0) {
        continue
      }

      // The reason sensors are polled at all. If a sensor moved and no event
      // announced it, the stream is not sufficient on its own and the plugin
      // needs its polling fallback to stay.
      const announced = announcedAt.get(sensor.id)
      const wasAnnounced = announced !== undefined && Date.now() - announced < 30_000
      const marker = wasAnnounced ? 'STATE ' : 'UNSEEN'

      stdout.write(
        `  ${elapsed(startedAt)}  ${marker} ${String(namesById.get(sensor.id)).padEnd(22)}`
          + ` state=${sensor.attributes.state} ocs=${sensor.attributes.openClosedStatus}`
          + `${wasAnnounced ? '' : '   <- no event announced this'}\n`,
      )
      for (const change of changes) {
        stdout.write(`             ${change.key}: ${change.from} -> ${change.to}\n`)
      }

      timeline.push({
        atMs: Date.now() - startedAt,
        kind: 'state',
        deviceId: sensor.id,
        wasAnnounced,
        changes,
      })
      previous.set(sensor.id, sensor.attributes)
    }
  }

  stop()
}

main().catch((error) => {
  stdout.write(`\nFailed: ${error?.message ?? error}\n`)
  process.exit(1)
})
