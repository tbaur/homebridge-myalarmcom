#!/usr/bin/env node
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Settle which request shape Alarm.com's partition command
 * endpoint actually accepts.
 *
 * Authenticated reads succeed while every arm and disarm comes back `500`
 * (issue #65). Everything the plugin sends on a command matches the
 * long-running community client except one header: the plugin labels the
 * request body `application/vnd.api+json`, reusing the value it asks for in
 * `Accept`, while every client known to arm a real panel sends
 * `application/json; charset=UTF-8`. This script sends the same command once
 * per candidate label and records which ones the server takes.
 *
 * It reimplements the protocol rather than driving `dist/`, for the reason
 * probe.mjs does: the shipping client is the thing under suspicion. No build
 * needed.
 *
 * This is the only script here that POSTs in order to learn something, so the
 * comparison is run as a disarm against a panel that is *already disarmed* —
 * a no-op at the panel. Sending it to an armed panel would really disarm the
 * house, so that combination needs `--force` on top of the typed confirmation.
 *
 * Usage:
 *   node scripts/probe-command.mjs                 report capabilities, send nothing
 *   node scripts/probe-command.mjs --compare       no-op disarm once per Content-Type
 *   node scripts/probe-command.mjs --arm stay      one real arm, watch it, disarm again
 *
 * A scrubbed report is written to probe-output/, which is never committed.
 * Console output names your panel; treat it as sensitive if you paste it.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stdout } from 'node:process'
import { fileURLToPath } from 'node:url'

import { handleHelp, hasFlag, readFlag, readNumericFlag } from './lib/cli.mjs'
import { confirmPhrase, resolveCredentials } from './lib/prompt.mjs'
import { createScrubber, redactFreeText } from './lib/scrub.mjs'
import {
  BASE_URL,
  IDENTITIES_URL,
  authenticatedGet,
  authenticatedPost,
  followRedirects,
  login,
  previewSecret,
} from './lib/session.mjs'

handleHelp(`
Find out which request shape Alarm.com's partition command endpoint accepts.

  node scripts/probe-command.mjs [options]

  --compare            Send the same no-op disarm once per candidate
                       Content-Type and report which ones the server accepts.
  --arm <mode>         Send one real arming command ("stay" or "away"), watch
                       the panel settle, then disarm again.
  --content-type <ct>  Content-Type for --arm. Defaults to the winner of
                       --compare, or to application/json; charset=UTF-8.
  --partition <id>     Which partition to use, when the account has several.
  --settle <seconds>   How long to watch an --arm settle (default: 60).
  --force              Allow --compare against a panel that is not already
                       disarmed. This really does disarm your house.
  -h, --help           Show this message.

With no write flag it signs in, prints what the panel advertises, and sends
nothing. --compare and --arm each require typing a confirmation phrase.

Credentials come from ADC_USERNAME, ADC_PASSWORD, and ADC_MFA_TOKEN, or are
prompted for when a terminal is attached.
`)

const outputDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'probe-output')

const PARTITIONS_URL = `${BASE_URL}/web/api/devices/partitions`

const PARTITION_STATE_NAMES = {
  0: 'UNKNOWN',
  1: 'DISARMED',
  2: 'ARMED_STAY',
  3: 'ARMED_AWAY',
  4: 'ARMED_NIGHT',
}

const ARMING_MODIFIER_NAMES = {
  0: 'BYPASS_SENSORS',
  1: 'NO_ENTRY_DELAY',
  2: 'SILENT_ARMING',
  3: 'NIGHT_ARMING',
  4: 'SELECTIVELY_BYPASS_SENSORS',
  5: 'FORCE_ARM',
}

const DISARMED = 1

/** The value the fix would ship, and the one --arm falls back to. */
const BROWSER_CONTENT_TYPE = 'application/json; charset=UTF-8'

/**
 * The labels to try, in the order they are sent.
 *
 * The first three vary only the header, holding the body constant, which is
 * what makes the comparison mean anything. The fourth varies the body instead:
 * if `vnd.api+json` fails flat but succeeds wrapped as a JSON:API document,
 * the server is not rejecting the label at all — it is honouring it, and
 * demanding the document shape that label promises. That distinction decides
 * whether the fix is "send a different Content-Type" or "send a different
 * body", and guessing between the two is how this bug got shipped.
 */
const VARIANTS = [
  {
    id: 'json-utf8',
    contentType: BROWSER_CONTENT_TYPE,
    isEnveloped: false,
    note: 'What every client known to arm a real panel sends. The proposed fix.',
  },
  {
    id: 'json-bare',
    contentType: 'application/json',
    isEnveloped: false,
    note: 'Same media type without the charset, to see whether the charset carries weight.',
  },
  {
    id: 'vnd-api',
    contentType: 'application/vnd.api+json',
    isEnveloped: false,
    note: 'What the plugin sends today. Expected to be the 500.',
  },
  {
    id: 'vnd-api-enveloped',
    contentType: 'application/vnd.api+json',
    isEnveloped: true,
    note: 'That label with a JSON:API document body, separating a wrong label from a wrong body.',
  },
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const stateName = (value) => `${value} (${PARTITION_STATE_NAMES[value] ?? 'unrecognised'})`

/** Whether the server took the command. */
const isAccepted = (result) => result.status >= 200 && result.status < 300

/** The command body the plugin builds today, which is what needs confirming. */
function commandBody(action) {
  return action === 'disarm'
    ? { statePollOnly: false }
    : { statePollOnly: false, noEntryDelay: false, silentArming: false }
}

/**
 * Wrap a flat command body as a JSON:API document.
 *
 * The resource type is taken from the partition Alarm.com just returned rather
 * than written here, because a guessed type would fail for a reason that has
 * nothing to do with the question being asked.
 */
function asJsonApiDocument(partition, body) {
  return { data: { type: partition.type, id: partition.id, attributes: body } }
}

/** Sign in, reporting enough about it to tell the failure modes apart. */
async function signIn() {
  const credentials = await resolveCredentials()

  stdout.write('\n-- Sign-in --\n')
  const { jar, loginJar, ajaxKey, diagnostics } = await login(credentials)

  stdout.write(`  login post       ${diagnostics.loginStatus}\n`)
  stdout.write(`  cookies          [${diagnostics.cookieNames.join(', ')}]\n`)
  stdout.write(`  anti-CSRF (afg)  ${previewSecret(ajaxKey)}\n`)
  stdout.write(`  MFA token sent   ${diagnostics.mfaTokenSentPreview}\n`)
  stdout.write(`  MFA token back   ${diagnostics.mfaTokenReturnedPreview}\n`)
  if (diagnostics.mfaTokenReplaced) {
    stdout.write('  NOTE             Alarm.com returned a DIFFERENT trust token than the one sent,\n')
    stdout.write('                   so the supplied one was not accepted for this session.\n')
  }

  if (diagnostics.mfaRequired) {
    throw new Error('Alarm.com demanded two-factor verification. Set ADC_MFA_TOKEN; see docs/AUTH.md.')
  }
  if (diagnostics.likelyRejected) {
    throw new Error('Alarm.com rejected the username or password.')
  }
  if (!ajaxKey) {
    throw new Error('Signed in but no "afg" cookie came back, so no API call can be made.')
  }

  return {
    jars: { jar, loginJar },
    ajaxKey,
    credentials: { wasTokenSent: diagnostics.mfaTokenSent },
  }
}

/** Read the identity document, which is where the user and system ids come from. */
async function readIdentity(session) {
  const identities = await authenticatedGet(IDENTITIES_URL, session)
  if (identities.status !== 200) {
    throw new Error(`identities returned ${identities.status}; cannot continue.`)
  }

  const identity = identities.body?.data?.[0]
  const systemId = identity?.relationships?.selectedSystem?.data?.id
  if (!systemId) {
    throw new Error('No selected system on the identity document.')
  }
  return { userId: identity?.id, systemId }
}

/**
 * Ask Alarm.com what it believes this account's two-factor state to be.
 *
 * Reached only when every cookie set was refused with a `409`, at which point
 * the useful question stops being "which cookies?" and becomes "what is this
 * account actually asking for?". A trust cookie that was sent, echoed back
 * unchanged, and still refused looks identical from the outside to one that
 * was never sent, and this document is what tells them apart.
 */
async function diagnoseTwoFactor(session, userId) {
  const url = `${BASE_URL}/web/api/engines/twoFactorAuthentication/twoFactorAuthentications/`
    + encodeURIComponent(userId)

  stdout.write('\n-- Two-factor state --\n')
  const result = await authenticatedGet(url, session)
  stdout.write(`  GET twoFactorAuthentications -> ${result.status}\n`)

  if (result.status !== 200 || !result.body?.data) {
    stdout.write('  Alarm.com would not describe it, so the cookie itself is all there is to go on.\n')
    return null
  }

  // Scrubbed before printing: this document carries the account's real phone
  // number and email, and this terminal output is what gets pasted into an
  // issue.
  const attributes = createScrubber().scrub(result.body).data?.attributes ?? {}
  for (const [key, value] of Object.entries(attributes)) {
    stdout.write(`  ${key.padEnd(34)} ${JSON.stringify(value)}\n`)
  }
  return attributes
}

/**
 * Turn a failed bake-off into the thing to do about it.
 *
 * Three 409 cases, each needing different advice: no cookie was sent, a cookie
 * was sent and Alarm.com states outright that the session is still untrusted,
 * or a cookie was sent and Alarm.com will not say why it refused. Collapsing
 * them loses the only actionable part, since "supply a cookie" is useless
 * advice to someone who just did.
 */
function explainSessionFailure(attempts, { wasTokenSent }, twoFactor) {
  const summary = attempts.map(({ name, status }) => `${name} -> ${status}`).join('; ')

  // A 409 on this surface is Alarm.com's two-factor challenge rather than an
  // ordinary conflict.
  if (!attempts.some(({ status }) => status === 409)) {
    return `No cookie set could read the system: ${summary}`
  }

  if (!wasTokenSent) {
    return 'Alarm.com answered 409 on the system route although the sign-in itself succeeded, which is '
      + "its way of demanding two-factor verification. Supply this account's twoFactorAuthenticationId "
      + `cookie, either at the prompt or as ADC_MFA_TOKEN, and run it again. See docs/AUTH.md. [${summary}]`
  }

  if (twoFactor?.isCurrentDeviceTrusted === false) {
    return 'A twoFactorAuthenticationId cookie was sent, and Alarm.com still reports '
      + 'isCurrentDeviceTrusted=false, so it did not count this session as having passed two-factor. '
      + 'The likeliest cause is a cookie captured from a browser sign-in where the '
      + 'remember/trust-this-device option was not ticked. Alarm.com sets the cookie either way, but '
      + 'only the trusted one carries off the machine that made it. Sign in again, trust the browser, '
      + `and copy the fresh value. See docs/AUTH.md. [${summary}]`
  }

  return 'A twoFactorAuthenticationId cookie was sent and Alarm.com still answered 409, so that cookie '
    + 'is not valid for this session. Its being echoed back unchanged does not mean it was accepted, '
    + 'because the server reflects whatever it is given. The usual causes are a cookie captured while '
    + 'signed in as a different Alarm.com account, and one that has already been invalidated, which '
    + 'rotating the account password does. Capture a fresh one in a browser signed in as this same '
    + `account, copying only that single cookie's value. See docs/AUTH.md. [${summary}]`
}

/**
 * Decide which cookie set to use, by measuring them against a real read.
 *
 * It has to be the system route that decides. The identity document is more
 * permissive and answers `200` for a session that everything else refuses, so
 * choosing on the strength of that read picks a session which then fails at
 * the first thing you actually wanted to do.
 *
 * Three configurations, in increasing order of what they assume: the
 * login-response cookies the plugin replays, every cookie collected, and every
 * cookie after following the post-login redirect chain a browser would.
 */
async function chooseSessionStrategy({ jars, ajaxKey, identity, credentials }) {
  const { jar, loginJar } = jars
  const systemUrl = `${BASE_URL}/web/api/systems/systems/${encodeURIComponent(identity.systemId)}`
  const attempts = []
  let system = null

  const attempt = async (name, session) => {
    const result = await authenticatedGet(systemUrl, session)
    const detail = redactFreeText(result.body?.errors?.[0]?.detail ?? null)
    attempts.push({ name, status: result.status, detail })
    stdout.write(`  ${result.status === 200 ? 'PASS' : 'fail'} ${String(result.status).padEnd(4)} ${name}`)
    stdout.write(detail ? ` (${detail})\n` : '\n')
    system = result.body
    return result.status === 200
  }

  stdout.write('\n-- Session strategy --\n')

  const loginOnly = { jar: loginJar, ajaxKey }
  if (await attempt('login-response cookies only, as the plugin does', loginOnly)) {
    return { session: loginOnly, cookieStrategy: 'login-response only', system, attempts }
  }

  const accumulated = { jar, ajaxKey }
  if (await attempt('all cookies, no warm-up', accumulated)) {
    return { session: accumulated, cookieStrategy: 'full jar', system, attempts }
  }

  // Signing in lands on DetermineLandingPage.aspx, which redirects on to the
  // dashboard. Some routes need the session context that chain establishes, so
  // a client stopping at the first 302 can hold a valid session and still be
  // refused here.
  const hops = await followRedirects(jar, '/web/DetermineLandingPage.aspx')
  for (const hop of hops) {
    stdout.write(`       ${hop.status} ${hop.path}${hop.location ? ` -> ${hop.location}` : ''}\n`)
  }
  if (await attempt('all cookies, after warm-up', accumulated)) {
    return { session: accumulated, cookieStrategy: 'full jar after warm-up', system, attempts }
  }

  const twoFactor = await diagnoseTwoFactor(loginOnly, identity.userId)
  throw new Error(explainSessionFailure(attempts, credentials, twoFactor))
}

/** Resolve the partitions this account can see. */
async function discoverPartitions(session, system) {
  const ids = (system?.data?.relationships?.partitions?.data ?? []).map((entry) => entry.id)
  if (ids.length === 0) {
    throw new Error('The selected system reports no partitions.')
  }

  const query = ids.map((id) => `ids%5B%5D=${encodeURIComponent(id)}`).join('&')
  const partitions = await authenticatedGet(`${PARTITIONS_URL}?${query}`, session)
  if (partitions.status !== 200) {
    throw new Error(`partition read returned ${partitions.status}; cannot continue.`)
  }

  return partitions.body?.data ?? []
}

/** Print what the panel says it can do, which is the input to every decision below. */
function reportCapabilities(partition) {
  const attributes = partition.attributes ?? {}

  stdout.write('\n-- Partition --\n')
  stdout.write(`  id                        ${partition.id}\n`)
  stdout.write(`  type                      ${partition.type}\n`)
  stdout.write(`  description               ${attributes.description}\n`)
  stdout.write(`  state                     ${stateName(attributes.state)}\n`)
  stdout.write(`  desiredState              ${attributes.desiredState}\n`)
  stdout.write(`  hasPermissionToChangeState ${attributes.hasPermissionToChangeState}\n`)
  stdout.write(`  hasOpenBypassableSensors  ${attributes.hasOpenBypassableSensors}\n`)
  stdout.write(`  supportsNightArmingSchedules ${attributes.supportsNightArmingSchedules}\n`)

  stdout.write('  extendedArmingOptions\n')
  const options = attributes.extendedArmingOptions ?? {}
  for (const [mode, codes] of Object.entries(options)) {
    const named = (codes ?? []).map((code) => ARMING_MODIFIER_NAMES[code] ?? code).join(', ')
    stdout.write(`    ${mode.padEnd(12)} [${named}]\n`)
  }
  if (Object.keys(options).length === 0) {
    stdout.write('    (absent)\n')
  }

  const invalid = attributes.invalidExtendedArmingOptions ?? {}
  if (Object.keys(invalid).length > 0) {
    stdout.write(`  invalidExtendedArmingOptions ${JSON.stringify(invalid)}\n`)
  }
}

/**
 * Check the response against what the plugin's client actually destructures.
 *
 * A `200` alone does not prove the fix works. `commandPartition` returns
 * `response.data` and its callers read `attributes.state`, so a success that
 * answers with some other shape would still break the accessory — one layer
 * further along, and much harder to attribute.
 */
function checkResponseShape(result) {
  if (!isAccepted(result)) {
    return null
  }
  const data = result.body?.data
  return {
    hasData: Boolean(data),
    hasId: typeof data?.id === 'string',
    hasStateAttribute: typeof data?.attributes?.state === 'number',
    reportedState: data?.attributes?.state ?? null,
    reportedDesiredState: data?.attributes?.desiredState ?? null,
  }
}

/** Print one attempt, and everything about it worth reading afterwards. */
function reportAttempt(label, attempt) {
  const verdict = attempt.isAccepted ? 'ACCEPTED' : 'REFUSED '
  stdout.write(`  ${verdict} ${String(attempt.status).padEnd(4)} ${String(attempt.durationMs).padStart(6)}ms  ${label}\n`)
  stdout.write(`             response ${attempt.responseContentType || '(none)'}\n`)

  if (attempt.setCookieNames.length > 0) {
    // If `afg` comes back here, the anti-CSRF value rotates mid-session and a
    // client that absorbs cookies only at login is replaying a stale one.
    stdout.write(`             set-cookie [${attempt.setCookieNames.join(', ')}]\n`)
  }
  if (attempt.responseShape) {
    const shape = attempt.responseShape
    stdout.write(`             shape data=${shape.hasData} id=${shape.hasId} state=${shape.hasStateAttribute}`
      + ` reported=${shape.reportedState}/${shape.reportedDesiredState}\n`)
  }
  if (!attempt.isAccepted) {
    stdout.write(`             body ${(attempt.responseText ?? '').slice(0, 600).trim() || '(empty)'}\n`)
  }
}

/** Send one command and record everything about the exchange. */
async function sendCommand(session, partition, action, variant) {
  const flat = commandBody(action)
  const body = variant.isEnveloped ? asJsonApiDocument(partition, flat) : flat
  const url = `${PARTITIONS_URL}/${encodeURIComponent(partition.id)}/${action}`

  const result = await authenticatedPost(url, session, { body, contentType: variant.contentType })

  return {
    variant: variant.id,
    action,
    contentType: variant.contentType,
    isEnveloped: variant.isEnveloped,
    requestBody: body,
    status: result.status,
    durationMs: result.durationMs,
    responseContentType: result.contentType,
    setCookieNames: result.setCookieNames,
    reissuedAjaxKey: result.setCookieNames.includes('afg'),
    responseShape: checkResponseShape(result),
    // A success is recorded parsed and a failure as text, because only the
    // parsed form goes through the scrubber field by field. `redactFreeText`
    // catches identifiers and contact details but not a device description,
    // so keeping a successful body as raw text would write the panel's name
    // into the one file whose purpose is being safe to attach to an issue.
    responseBody: isAccepted(result) ? result.body : null,
    responseText: isAccepted(result) ? null : redactFreeText(result.text.slice(0, 2_000)),
    isAccepted: isAccepted(result),
  }
}

/** Refuse to write to a panel where doing so would be a surprise. */
function assertSafeToCompare(attributes) {
  if (attributes.hasPermissionToChangeState !== true) {
    throw new Error(
      'This account cannot change the arming state, so every command would be refused for that reason '
        + 'rather than the one being investigated. Run it with an account that has write permission.',
    )
  }
  if (attributes.state !== DISARMED && !hasFlag('--force')) {
    throw new Error(
      `The panel is ${stateName(attributes.state)}. The comparison sends real disarms, which would disarm `
        + 'your house. Disarm it first so the commands are a no-op, or pass --force if you meant it.',
    )
  }
}

/**
 * Send the same disarm once per candidate label and report which ones land.
 *
 * Every attempt is sent even after one succeeds. On an already-disarmed panel
 * they cost nothing, and knowing that two labels work and two do not is what
 * turns the fix from a guess into a measurement.
 */
async function compareContentTypes(session, partition) {
  const attributes = partition.attributes ?? {}
  assertSafeToCompare(attributes)

  stdout.write('\n-- What will be sent --\n')
  stdout.write(`  POST ${PARTITIONS_URL}/${partition.id}/disarm\n`)
  stdout.write(`  body ${JSON.stringify(commandBody('disarm'))}\n`)
  stdout.write(`  once per Content-Type below, ${VARIANTS.length} commands in total\n\n`)
  for (const variant of VARIANTS) {
    stdout.write(`    ${variant.contentType}${variant.isEnveloped ? '  (JSON:API document body)' : ''}\n`)
    stdout.write(`      ${variant.note}\n`)
  }
  stdout.write(
    attributes.state === DISARMED
      ? '\n  The panel is already disarmed, so each of these is a no-op at the panel.\n'
      : '\n  WARNING: the panel is NOT disarmed. These commands will really disarm it.\n',
  )
  stdout.write('  Each one is a real entry in your Alarm.com history.\n')

  if (!(await confirmPhrase('\nSend them?', 'disarm'))) {
    throw new Error('Not confirmed; nothing was sent.')
  }

  stdout.write('\n-- Results --\n')
  const attempts = []
  for (const variant of VARIANTS) {
    const attempt = await sendCommand(session, partition, 'disarm', variant)
    reportAttempt(`${variant.contentType}${variant.isEnveloped ? ' + JSON:API body' : ''}`, attempt)
    attempts.push(attempt)
  }
  return attempts
}

/** Read one partition back. */
async function readPartition(session, partitionId) {
  const result = await authenticatedGet(`${PARTITIONS_URL}/${encodeURIComponent(partitionId)}`, session)
  return result.body?.data ?? null
}

/**
 * Watch a partition until it stops moving.
 *
 * Arming takes 20-30 seconds to settle, and the command response is returned
 * long before that, so the response body is not evidence that the panel did
 * anything. This is.
 */
async function watchUntilSettled(session, partitionId, settleSeconds) {
  const deadline = Date.now() + settleSeconds * 1_000
  const startedAt = Date.now()
  const transitions = []
  let previous = null

  while (Date.now() < deadline) {
    await sleep(3_000)
    const current = (await readPartition(session, partitionId))?.attributes
    if (!current) {
      continue
    }

    const hasMoved = previous === null
      || current.state !== previous.state
      || current.desiredState !== previous.desiredState

    if (hasMoved) {
      const atMs = Date.now() - startedAt
      stdout.write(`  ${(atMs / 1000).toFixed(1).padStart(6)}s  state=${stateName(current.state)}`
        + `  desired=${current.desiredState}\n`)
      transitions.push({ atMs, state: current.state, desiredState: current.desiredState })
    }
    previous = current

    // Settled once the panel has reached what it said it wanted and has moved
    // at least once, so the reading taken before the command landed does not
    // count as having arrived.
    const isSettled = current.desiredState === undefined || current.desiredState === current.state
    if (isSettled && transitions.length > 1) {
      break
    }
  }

  return transitions
}

/**
 * Send one real arming command and put the panel back.
 *
 * The disarm runs even when the watch is interrupted. Leaving someone's house
 * armed because a development script exited badly is not an acceptable
 * outcome, and a second Ctrl-C during that disarm is ignored rather than
 * allowed to kill the process mid-command.
 */
async function runArmCycle(session, partition, { mode, contentType, settleSeconds }) {
  const action = mode === 'away' ? 'armAway' : 'armStay'
  const variant = { id: 'arm', contentType, isEnveloped: false }

  if (partition.attributes?.hasPermissionToChangeState !== true) {
    throw new Error('This account cannot change the arming state.')
  }

  stdout.write('\n-- Real arming command --\n')
  stdout.write(`  POST ${PARTITIONS_URL}/${partition.id}/${action}\n`)
  stdout.write(`  body ${JSON.stringify(commandBody(action))}\n`)
  stdout.write(`  Content-Type: ${contentType}\n`)
  stdout.write('  This really arms your panel. It is disarmed again afterwards, including on Ctrl-C.\n')

  if (!(await confirmPhrase('\nSend it?', action))) {
    throw new Error('Not confirmed; nothing was sent.')
  }

  let isDisarming = false
  const disarm = async () => {
    if (isDisarming) {
      stdout.write('\n  Already disarming; ignoring.\n')
      return null
    }
    isDisarming = true
    stdout.write('\n-- Putting it back --\n')
    const result = await sendCommand(session, partition, 'disarm', variant)
    reportAttempt(`disarm via ${contentType}`, result)
    return result
  }

  const onInterrupt = () => { void disarm().then(() => process.exit(130)) }
  process.on('SIGINT', onInterrupt)

  try {
    const armed = await sendCommand(session, partition, action, variant)
    reportAttempt(`${action} via ${contentType}`, armed)

    let transitions = []
    if (armed.isAccepted) {
      stdout.write('\n-- Settling --\n')
      transitions = await watchUntilSettled(session, partition.id, settleSeconds)
    }

    const disarmed = await disarm()
    return { armed, transitions, disarmed }
  } finally {
    process.off('SIGINT', onInterrupt)
  }
}

/** Say what the run proved, in the terms the fix will be written in. */
function reportVerdict(attempts) {
  stdout.write('\n-- Verdict --\n')

  const accepted = attempts.filter((attempt) => attempt.isAccepted)
  const plugin = attempts.find((attempt) => attempt.variant === 'vnd-api')

  if (accepted.length === 0) {
    stdout.write('  Every label was refused, so the Content-Type is not the whole story.\n')
    stdout.write('  Compare the response bodies above; the status alone is not enough here.\n')
    return
  }

  for (const attempt of accepted) {
    stdout.write(`  ACCEPTED  ${attempt.contentType}${attempt.isEnveloped ? ' + JSON:API body' : ''}\n`)
  }

  if (plugin && !plugin.isAccepted) {
    stdout.write(`\n  The plugin's current label returned ${plugin.status}, and at least one other worked.\n`)
    stdout.write('  That is issue #65: src/api/client.ts reuses JSON_API_ACCEPT for Content-Type.\n')
  } else if (plugin?.isAccepted) {
    stdout.write("\n  The plugin's current label was accepted too, so the 500 is something else.\n")
    stdout.write('  Re-run against the reporting account; this one does not reproduce it.\n')
  }

  const broken = accepted.filter((attempt) => attempt.responseShape && !attempt.responseShape.hasStateAttribute)
  if (broken.length > 0) {
    stdout.write('\n  Accepted, but the response is not the shape the client destructures.\n')
    stdout.write('  commandPartition returns response.data and its callers read attributes.state.\n')
  }

  if (attempts.some((attempt) => attempt.reissuedAjaxKey)) {
    stdout.write('\n  Alarm.com reissued the "afg" cookie on a command response.\n')
    stdout.write('  Cookies are absorbed only at login today, so the plugin would keep replaying a stale one.\n')
  }
}

/** Write the run somewhere it can be attached to the issue. */
function writeReport(report) {
  mkdirSync(outputDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(outputDir, `command-probe-${stamp}.json`)
  writeFileSync(file, JSON.stringify(createScrubber().scrub(report), null, 2))
  stdout.write(`\n  Scrubbed report written to ${file}\n`)
  return file
}

/** Pick the partition to work with, refusing to guess when it matters. */
function selectPartition(partitions) {
  const requested = readFlag('--partition', '1234567-127')
  if (requested) {
    const match = partitions.find((partition) => partition.id === requested)
    if (!match) {
      throw new Error(`No partition "${requested}". Found: ${partitions.map((p) => p.id).join(', ')}`)
    }
    return match
  }
  if (partitions.length > 1) {
    throw new Error(`This account has ${partitions.length} partitions. Choose one with --partition <id>: `
      + partitions.map((p) => p.id).join(', '))
  }
  return partitions[0]
}

/** The Content-Type an --arm should use, preferring what --compare just proved. */
function chooseArmContentType(attempts) {
  const override = readFlag('--content-type', 'application/json')
  if (override) {
    return override
  }
  const winner = attempts.find((attempt) => attempt.isAccepted && !attempt.isEnveloped)
  return winner?.contentType ?? BROWSER_CONTENT_TYPE
}

async function main() {
  const armMode = readFlag('--arm', 'stay')
  if (armMode !== undefined && armMode !== 'stay' && armMode !== 'away') {
    throw new Error(`--arm takes "stay" or "away"; got "${armMode}".`)
  }
  const settleSeconds = readNumericFlag('--settle', { fallback: 60, min: 5, max: 600 })

  const { jars, ajaxKey, credentials } = await signIn()
  const identity = await readIdentity({ jar: jars.loginJar, ajaxKey })
  const { session, cookieStrategy, system } = await chooseSessionStrategy({
    jars,
    ajaxKey,
    identity,
    credentials,
  })
  stdout.write(`  -> using "${cookieStrategy}"\n`)

  const partitions = await discoverPartitions(session, system)
  const partition = selectPartition(partitions)
  reportCapabilities(partition)

  const report = {
    startedAt: new Date().toISOString(),
    cookieStrategy,
    partition,
    attempts: [],
  }

  if (!hasFlag('--compare') && armMode === undefined) {
    stdout.write('\n  Read-only run; nothing was sent.\n')
    stdout.write('  Add --compare to test the Content-Type, or --arm stay for an end-to-end check.\n')
    writeReport(report)
    return
  }

  let attempts = []
  if (hasFlag('--compare')) {
    attempts = await compareContentTypes(session, partition)
    report.attempts = attempts
    reportVerdict(attempts)
  }

  if (armMode !== undefined) {
    const contentType = chooseArmContentType(attempts)
    const cycle = await runArmCycle(session, partition, { mode: armMode, contentType, settleSeconds })
    report.armCycle = {
      contentType,
      armed: cycle.armed,
      transitions: cycle.transitions,
      disarmed: cycle.disarmed,
    }
    report.finalState = (await readPartition(session, partition.id))?.attributes?.state ?? null
    stdout.write(`\n  Final state ${stateName(report.finalState)}\n`)
  }

  writeReport(report)
}

main().catch((error) => {
  stdout.write(`\nFailed: ${redactFreeText(String(error?.message ?? error))}\n`)
  process.exit(1)
})
