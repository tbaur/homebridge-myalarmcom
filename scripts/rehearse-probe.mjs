#!/usr/bin/env node
/**
 * Rehearse the accessory probe's waiting helpers against a fake panel.
 *
 * These helpers decide when a live run has finished, and getting them wrong is
 * expensive in a way ordinary bugs are not: it costs somebody an arm/disarm
 * cycle on a real house to find out. Three runs were spent that way. One
 * waited for the panel to be "disarmed" and returned instantly, because the
 * panel starts disarmed — so the run wrote its report twelve seconds in and
 * exited while the arm was still on its way, leaving the panel to arm itself
 * with nobody left to disarm it.
 *
 * The shape that catches it is a panel that starts and ends in the same state
 * with a different one in between. Run this before any live probe change:
 *
 *   node scripts/rehearse-probe.mjs
 */
import { stdout } from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'

import {
  coordinateCleanup,
  readUntilSettled,
  waitForLogLine,
  waitForPanelToSettle,
} from './probe-accessory.mjs'

const DISARMED = 1
const ARMED_AWAY = 3

let failureCount = 0

function check(name, isOk, detail) {
  stdout.write(`${isOk ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}\n`)
  if (!isOk) {
    failureCount++
  }
}

/** A panel that arms, then disarms, ending where it began. */
async function rehearseSettlingThroughAnArm() {
  const startedAt = Date.now()
  const stateAt = (ms) => (ms < 2_000 ? DISARMED : ms < 8_000 ? ARMED_AWAY : DISARMED)
  const client = {
    getPartitions: async () => [{ attributes: { state: stateAt(Date.now() - startedAt) } }],
  }

  const settled = await readUntilSettled(client, 'x', { quietMs: 4_000, timeoutMs: 30_000 })
  const elapsedMs = Date.now() - startedAt

  // Both halves matter. The right answer returned too early is the failure
  // that shipped, because the state it reports is correct by coincidence.
  check(
    'readUntilSettled waits through an arm rather than answering from the start',
    settled === DISARMED && elapsedMs > 10_000,
    `state=${settled} after ${(elapsedMs / 1000).toFixed(1)}s`,
  )
}

/** A panel that never stops moving must time out, not invent an answer. */
async function rehearseGivingUp() {
  const startedAt = Date.now()
  let reading = 0
  const client = { getPartitions: async () => [{ attributes: { state: reading++ % 2 } }] }

  await readUntilSettled(client, 'x', { quietMs: 4_000, timeoutMs: 12_000 })

  check('readUntilSettled gives up on a panel that keeps moving', Date.now() - startedAt >= 12_000)
}

/** Quiet, not a value, is what tells the watcher a scenario has finished. */
async function rehearseWaitingForQuiet() {
  const watcher = { samples: [{ state: DISARMED }] }
  const startedAt = Date.now()

  const keepMoving = (async () => {
    for (let index = 0; index < 3; index++) {
      await sleep(2_000)
      watcher.samples.push({ state: ARMED_AWAY })
    }
  })()

  const isQuiet = await waitForPanelToSettle(watcher, { quietMs: 5_000, timeoutMs: 40_000 })
  await keepMoving

  check(
    'waitForPanelToSettle waits for quiet, not for a value',
    isQuiet && Date.now() - startedAt >= 11_000,
    `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  )
}

async function rehearseLogWaiting() {
  const log = { entries: [] }
  const startedAt = Date.now()
  setTimeout(() => log.entries.push({ text: 'Home: Disarmed, accepted in 27.4s' }), 3_000)

  const isFound = await waitForLogLine(log, 'Disarmed, accepted in', 20_000)
  check('waitForLogLine waits for the line', isFound && Date.now() - startedAt >= 3_000)

  const isMissing = await waitForLogLine({ entries: [] }, 'never appears', 3_000)
  check('waitForLogLine gives up when the line never comes', isMissing === false)
}

/**
 * An interrupt, a crash and the normal exit all want the panel put back, and
 * they can arrive together. Starting a second disarm, or exiting through the
 * first, both end with an armed panel.
 */
async function rehearseCleanupCoordination() {
  let slot = null
  const readSlot = () => slot
  const writeSlot = (value) => { slot = value }

  let runCount = 0
  let isNeeded = true
  const runCleanup = async () => {
    runCount++
    await sleep(300)
    isNeeded = false
  }

  const call = () => coordinateCleanup(readSlot, writeSlot, () => isNeeded, runCleanup)

  // Three arrivals at once: the disarm must run once and all three must wait
  // for it, so nobody calls process.exit while it is still going.
  await Promise.all([call(), call(), call()])
  check('concurrent callers join one cleanup', runCount === 1, `ran ${runCount}x`)

  // Nothing armed, nothing to do.
  await call()
  check('cleanup is skipped when nothing is armed', runCount === 1)

  // A later scenario arms again, so the slot must have been freed.
  isNeeded = true
  await call()
  check('the slot frees for the next armed scenario', runCount === 2, `ran ${runCount}x`)

  // A failing cleanup must not wedge the slot shut forever.
  isNeeded = true
  slot = null
  let hasRejected = false
  const failing = coordinateCleanup(readSlot, writeSlot, () => true, async () => {
    throw new Error('disarm failed')
  })
  await failing.catch(() => { hasRejected = true })
  check('a failed cleanup rejects and frees the slot', hasRejected && slot === null)
}

stdout.write('\nRehearsing the probe\'s waiting helpers against a fake panel.\n')
stdout.write('Takes about a minute; no account and no panel involved.\n\n')

await rehearseSettlingThroughAnArm()
await rehearseGivingUp()
await rehearseWaitingForQuiet()
await rehearseLogWaiting()
await rehearseCleanupCoordination()

stdout.write(failureCount === 0
  ? '\nAll rehearsals passed. A live run will measure to its end.\n'
  : `\n${failureCount} rehearsal(s) FAILED. Do not spend a live run on this.\n`)
process.exitCode = failureCount === 0 ? 0 : 1
