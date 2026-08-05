#!/usr/bin/env node
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Discovery tool for the undocumented Alarm.com web API.
 *
 * It signs in once, reports what the account exposes, probes for a friendlier
 * authentication path than the browser-cookie dance the existing community
 * plugin requires, and writes scrubbed JSON:API payloads to `probe-output/`
 * for use as test fixtures.
 *
 * Safety properties, both deliberate:
 *
 *  - **One login, throttled requests.** Alarm.com locks accounts that
 *    authenticate or poll too aggressively.
 *  - **Capability discovery is GET-only.** This talks to a live security
 *    system; probing an unknown endpoint with POST could arm, disarm, or
 *    unlock something. Nothing here can change state.
 *
 * Usage:
 *   node scripts/probe.mjs
 *   ADC_USERNAME=you@example.com ADC_MFA_TOKEN=... node scripts/probe.mjs
 *   node scripts/probe.mjs --ws 60      # also listen for WebSocket events
 *
 * Credentials come from `ADC_USERNAME`, `ADC_PASSWORD`, and `ADC_MFA_TOKEN`,
 * or are prompted for. The password prompt does not echo. Nothing secret is
 * printed or written to disk.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { stdout } from 'node:process'
import { fileURLToPath } from 'node:url'

import { handleHelp, readNumericFlag } from './lib/cli.mjs'
import { resolveCredentials } from './lib/prompt.mjs'
import { createScrubber, redactFreeText } from './lib/scrub.mjs'
import {
  authenticatedGet,
  BASE_URL,
  followRedirects,
  IDENTITIES_URL,
  isWebSocketUrl,
  login,
  previewSecret,
} from './lib/session.mjs'

handleHelp(`
Discover what an Alarm.com account exposes, and capture scrubbed fixtures.

  node scripts/probe.mjs [--ws <seconds>]

  --ws <seconds>  Also listen for WebSocket events for this long (max 3600).
  -h, --help      Show this message.

GET-only: nothing here can arm, disarm, or unlock anything. One login, and
every request is throttled, because Alarm.com locks accounts that poll or
authenticate aggressively.

Output goes to probe-output/, which is gitignored. It is scrubbed on a
best-effort basis; review it before sharing.

Credentials come from ADC_USERNAME, ADC_PASSWORD, and ADC_MFA_TOKEN, or are
prompted for when a terminal is attached. Prefer the prompts: inline
assignments land in your shell history and are visible in "ps".
`)

const OUTPUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'probe-output')

/** Alarm.com 404s batch reads with too many `ids[]` params. Stay under it. */
const MAX_IDS_PER_REQUEST = 50

/** Device collections reachable from a system's `relationships`. */
const DEVICE_COLLECTIONS = [
  { key: 'partitions', path: '/web/api/devices/partitions' },
  { key: 'sensors', path: '/web/api/devices/sensors' },
  { key: 'locks', path: '/web/api/devices/locks' },
  { key: 'garageDoors', path: '/web/api/devices/garageDoors' },
  { key: 'lights', path: '/web/api/devices/lights' },
  { key: 'thermostats', path: '/web/api/devices/thermostats' },
  { key: 'cameras', path: '/web/api/video/devices/cameras' },
]

/**
 * Endpoints worth testing for a better authentication story than "copy a
 * cookie out of your browser". Every entry is a hypothesis; most may 404, and
 * that is a useful result. `identities` is included as a control: if the
 * control fails, the session died and every other result is meaningless.
 */
function buildAuthCandidates({ userId, systemId }) {
  return [
    {
      name: 'identities (control)',
      url: IDENTITIES_URL,
      why: 'Known-good endpoint. Proves the session is still alive so other failures mean something.',
    },
    {
      name: 'two-factor state',
      url: `${BASE_URL}/web/api/engines/twoFactorAuthentication/twoFactorAuthentications/${userId}`,
      why: 'If this describes the enrolled factors, the plugin can drive MFA itself and mint its own trust token.',
    },
    {
      name: 'keep-alive (web)',
      url: `${BASE_URL}/web/KeepAlive.aspx`,
      why: 'identities reports logoutTimeoutMs and enableKeepAlive, implying a refresh exists. Extending a session beats re-authenticating.',
    },
    {
      name: 'keep-alive (api)',
      url: `${BASE_URL}/web/api/identities/${userId}`,
      why: 'Second candidate for a cheap session-touch that resets the idle timer.',
    },
    {
      name: 'openid discovery',
      url: `${BASE_URL}/.well-known/openid-configuration`,
      why: 'Long shot. A real OIDC issuer would mean a proper token flow instead of scraped cookies.',
    },
    {
      name: 'available system items',
      url: `${BASE_URL}/web/api/systems/availableSystemItems`,
      why: 'Would let discovery skip a round trip by listing systems without an ID.',
    },
    {
      name: 'bulk app payload',
      url: `${BASE_URL}/web/api/appload`,
      why: 'If the mobile app fetches all state in one call, polling could be one request instead of eight.',
    },
    {
      name: 'generic device collection',
      url: `${BASE_URL}/web/api/devices/devices`,
      why: 'Would collapse seven per-type reads into one.',
    },
    {
      name: 'trouble conditions',
      url: `${BASE_URL}/web/api/systems/systems/${systemId}/troubleConditions`,
      why: 'Panel fault detail, for mapping StatusFault more precisely than the current boolean.',
    },
  ]
}

/** Describe a JSON body's shape without printing its contents. */
function describeShape(body) {
  if (body === null || typeof body !== 'object') {return typeof body}
  if (Array.isArray(body)) {return `array(${body.length})`}
  const parts = Object.entries(body).map(([key, value]) => {
    if (Array.isArray(value)) {return `${key}: array(${value.length})`}
    if (value !== null && typeof value === 'object') {return `${key}: {${Object.keys(value).slice(0, 6).join(', ')}}`}
    return `${key}: ${typeof value}`
  })
  return parts.slice(0, 10).join(', ')
}

async function writeFixture(name, payload) {
  await mkdir(OUTPUT_DIR, { recursive: true })
  await writeFile(join(OUTPUT_DIR, name), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

/** Split identifiers into batches Alarm.com will actually answer. */
function chunk(items, size) {
  const batches = []
  for (let index = 0; index < items.length; index += size) {batches.push(items.slice(index, index + size))}
  return batches
}

/** Fetch one device collection, batching `ids[]` to stay under the 404 limit. */
async function fetchCollection(session, path, identifiers) {
  const documents = []
  for (const batch of chunk(identifiers, MAX_IDS_PER_REQUEST)) {
    const query = batch.map((id) => `ids%5B%5D=${encodeURIComponent(id)}`).join('&')
    const { status, body } = await authenticatedGet(`${BASE_URL}${path}?${query}`, session)
    if (status !== 200 || !body?.data) {return { status, documents }}
    documents.push(...(Array.isArray(body.data) ? body.data : [body.data]))
  }
  return { status: 200, documents }
}

/**
 * Histogram of sensor `deviceType` values with the states each one reports.
 *
 * This is the highest-value output of the whole run: it says exactly which
 * sensor types this panel produces, so the HomeKit mappers get built against
 * observed reality instead of a guessed enum.
 */
function summarizeSensors(documents) {
  const byType = new Map()
  for (const document of documents) {
    const attributes = document.attributes ?? {}
    const deviceType = attributes.deviceType ?? 'unknown'
    if (!byType.has(deviceType)) {
      byType.set(deviceType, { deviceType, count: 0, states: new Set(), stateTexts: new Set(), openClosed: new Set() })
    }
    const entry = byType.get(deviceType)
    entry.count += 1
    entry.states.add(attributes.state)
    if (attributes.stateText) {entry.stateTexts.add(attributes.stateText)}
    if (attributes.openClosedStatus !== undefined) {entry.openClosed.add(attributes.openClosedStatus)}
  }
  return [...byType.values()].map((entry) => ({
    deviceType: entry.deviceType,
    count: entry.count,
    states: [...entry.states],
    stateTexts: [...entry.stateTexts],
    openClosedStatus: [...entry.openClosed],
  }))
}

/**
 * Render a probed URL with account identifiers replaced by placeholders.
 *
 * The captured payloads are scrubbed, so the run summary must be too. Recording
 * the concrete URL would put the real user and system IDs into a file whose
 * whole purpose is being safe to read and share.
 */
function safePath(url, { userId, systemId }) {
  const NO_MATCH = '\u0000'
  return new URL(url).pathname
    .replaceAll(userId ?? NO_MATCH, '{userId}')
    .replaceAll(systemId ?? NO_MATCH, '{systemId}')
}

async function probeAuthCandidates(session, context, scrubber) {
  stdout.write('\n── Authentication capability probe (GET only) ──\n')
  const results = []
  const bodies = {}
  for (const candidate of buildAuthCandidates(context)) {
    const { status, contentType, isJson, body, location } = await authenticatedGet(candidate.url, session)
    const shape = isJson ? describeShape(body) : contentType || 'non-json'
    // Redirect targets carry account identifiers in their query strings, and
    // this is printed as well as recorded.
    const safeLocation = location ? safePath(new URL(location, BASE_URL).href, context) : null
    results.push({
      name: candidate.name,
      path: safePath(candidate.url, context),
      status,
      shape,
      location: safeLocation,
      why: candidate.why,
    })
    // Keep the bodies of successful JSON probes. The two-factor document in
    // particular decides whether the plugin can drive MFA itself instead of
    // asking the user to copy a cookie out of their browser.
    if (isJson && status === 200) {bodies[candidate.name] = body}

    const verdict = status === 200 ? 'HIT ' : '    '
    stdout.write(`${verdict}${String(status).padEnd(4)} ${candidate.name}\n`)
    if (status === 200) {stdout.write(`          ${shape}\n`)}
    else if (safeLocation) {stdout.write(`          -> ${safeLocation}\n`)}
  }

  await writeFixture('auth-candidates.json', scrubber.scrub(bodies))
  return results
}

async function captureDevices(session, systemId, scrubber, context) {
  const systemUrl = `${BASE_URL}/web/api/systems/systems/${systemId}`
  const { status, body, contentType, location } = await authenticatedGet(systemUrl, session)

  if (status !== 200) {
    // Record enough to tell the three failure modes apart: a redirect means the
    // session lacks context, an HTML body means the route does not exist, and a
    // JSON error body means the route exists and refused us.
    const failure = {
      path: safePath(systemUrl, context),
      status,
      contentType,
      location: location ? safePath(new URL(location, BASE_URL).href, context) : null,
      // Redacted here rather than at the point of printing. Alarm.com error
      // bodies quote back whatever was asked for, identifiers included, and
      // they are inside prose that the document scrubber's whole-value shape
      // rules cannot see. Redacting only the printed copy left the terminal
      // looking safe while the same text went verbatim into `summary.json`.
      errors: body?.errors ? JSON.parse(redactFreeText(JSON.stringify(body.errors))) : null,
    }
    stdout.write(`\nSystem read returned ${status} (${contentType || 'no content-type'})`)
    stdout.write(location ? ` -> ${failure.location}\n` : '\n')
    if (failure.errors) {stdout.write(`  errors: ${JSON.stringify(failure.errors)}\n`)}
    return { inventory: {}, sensorSummary: [], failure }
  }

  // Name the file after the pseudonymized id so multi-system accounts do not
  // overwrite each other and no real identifier reaches the filesystem.
  const scrubbedSystem = scrubber.scrub(body)
  await writeFixture(`system-${scrubbedSystem.data?.id ?? 'unknown'}.json`, scrubbedSystem)
  const relationships = body.data?.relationships ?? {}

  stdout.write('\n── Device inventory ──\n')
  const inventory = {}
  const collectionStatuses = {}
  let sensorSummary = []

  for (const collection of DEVICE_COLLECTIONS) {
    const identifiers = (relationships[collection.key]?.data ?? []).map((entry) => entry.id)
    inventory[collection.key] = identifiers.length
    if (identifiers.length === 0) {
      stdout.write(`  ${collection.key.padEnd(13)} 0\n`)
      continue
    }
    const { status: collectionStatus, documents } = await fetchCollection(session, collection.path, identifiers)
    collectionStatuses[collection.key] = collectionStatus
    stdout.write(`  ${collection.key.padEnd(13)} ${identifiers.length} (captured ${documents.length}, HTTP ${collectionStatus})\n`)
    if (documents.length > 0) {await writeFixture(`${collection.key}.json`, scrubber.scrub(documents))}
    if (collection.key === 'sensors') {sensorSummary = summarizeSensors(documents)}
  }

  return { inventory, sensorSummary, collectionStatuses, failure: null }
}

/** Connect to the event stream briefly and record the shapes that arrive. */
async function listenForEvents(session, seconds) {
  // Checked before the token request, not after. `globalThis.WebSocket` is behind
  // a flag until Node 22 while the package supports Node 20, so on the declared
  // minimum this used to throw `WebSocket is not defined` — after having already
  // spent a login, which is the one resource this whole script exists to
  // conserve.
  const SocketConstructor = globalThis.WebSocket
  if (!SocketConstructor) {
    stdout.write('\nThis Node build has no global WebSocket (it arrived in Node 22).\n')
    stdout.write('Skipping event capture; re-run on Node 22+ to capture event frames.\n')
    return []
  }

  const { status, body } = await authenticatedGet(`${BASE_URL}/web/api/websockets/token`, session)
  if (status !== 200 || !body?.value) {
    stdout.write(`\nWebSocket token request returned ${status}; skipping event capture.\n`)
    return []
  }

  // Checked before the token is appended to it, the same way the plugin does.
  // The endpoint is chosen by the server and the token is a live credential,
  // so an unchecked value decides where that credential is sent.
  const named = body.metaData?.endpoint
  const endpoint = named && isWebSocketUrl(named) ? named : 'wss://webskt.alarm.com:8443'
  if (named && endpoint !== named) {
    stdout.write('\nIgnoring an event stream endpoint that is not secure alarm.com; using the default.\n')
  }

  stdout.write(`\n── Listening for events for ${seconds}s (${endpoint}) ──\n`)
  stdout.write('Trip a sensor now to capture its event shape.\n')

  const socket = new SocketConstructor(`${endpoint}?auth=${body.value}`)
  const events = []
  socket.addEventListener('message', (message) => {
    try {
      const event = JSON.parse(message.data)
      events.push(event)
      stdout.write(`  EventType=${event.EventType} DeviceId=${event.DeviceId} Value=${event.EventValue}\n`)
    } catch {
      stdout.write('  (unparseable frame)\n')
    }
  })
  socket.addEventListener('error', () => stdout.write('  (socket error)\n'))

  await new Promise((resolveWait) => setTimeout(resolveWait, seconds * 1000))
  socket.close()
  stdout.write(`Captured ${events.length} event(s).\n`)
  return events
}

/**
 * Decide which cookie set to use for API calls by trying them against a real
 * read, cheapest and most-proven first.
 *
 * The long-running community plugin replays only the cookies the login POST
 * returned, and that implementation demonstrably works against live accounts.
 * Accumulating cookies from the login page and the post-login redirect chain
 * seems more correct, but a later hop can hand back a fresh, untrusted
 * `twoFactorAuthenticationId` that overwrites the good one. Rather than reason
 * about which is right, measure it.
 */
async function chooseSessionStrategy({ jar, loginJar, ajaxKey }, systemId, context) {
  const systemUrl = `${BASE_URL}/web/api/systems/systems/${systemId}`
  const attempts = []

  const attempt = async (name, session) => {
    const { status, body } = await authenticatedGet(systemUrl, session)
    const detail = redactFreeText(body?.errors?.[0]?.detail ?? null)
    attempts.push({ name, status, detail })
    stdout.write(`  ${status === 200 ? 'PASS' : 'fail'} ${String(status).padEnd(4)} ${name}`)
    stdout.write(detail ? ` (${detail})\n` : '\n')
    return status === 200
  }

  stdout.write('\n── Session strategy bake-off ──\n')
  stdout.write(`  probing ${safePath(systemUrl, context)}\n`)

  const loginOnly = { jar: loginJar, ajaxKey }
  if (await attempt('login-response cookies only (community client)', loginOnly)) {
    return { session: loginOnly, strategy: 'loginJar', attempts, hops: [] }
  }

  const accumulated = { jar, ajaxKey }
  if (await attempt('all cookies, no warm-up', accumulated)) {
    return { session: accumulated, strategy: 'jar', attempts, hops: [] }
  }

  const hops = await followRedirects(jar, '/web/DetermineLandingPage.aspx')
  for (const hop of hops) {stdout.write(`       ${hop.status} ${hop.path}${hop.location ? ` -> ${hop.location}` : ''}\n`)}
  if (await attempt('all cookies, after warm-up', accumulated)) {
    return { session: accumulated, strategy: 'jar+warmup', attempts, hops }
  }

  return { session: loginOnly, strategy: 'none', attempts, hops }
}

async function main() {
  const wsSeconds = readNumericFlag('--ws', { fallback: 0, min: 0, max: 3_600 })

  // A run spends a login, which is the operation Alarm.com polices hardest, and
  // every fixture is written at the very end. Interrupting used to throw the
  // whole run away, login included.
  process.on('SIGINT', () => {
    stdout.write('\n\nInterrupted. Fixtures captured so far are already in probe-output/.\n')
    process.exit(130)
  })

  const credentials = await resolveCredentials()
  stdout.write('\n── Sign-in ──\n')
  const { jar, loginJar, ajaxKey, diagnostics } = await login(credentials)

  stdout.write(`  login page       ${diagnostics.loginPageStatus}\n`)
  stdout.write(`  hidden fields    found=[${diagnostics.hiddenFieldsFound.join(', ')}]\n`)
  if (diagnostics.hiddenFieldsMissing.length > 0) {
    stdout.write(`  MISSING FIELDS   [${diagnostics.hiddenFieldsMissing.join(', ')}] — login form changed\n`)
  }
  stdout.write(`  login post       ${diagnostics.loginStatus}\n`)
  stdout.write(`  cookies          [${diagnostics.cookieNames.join(', ')}]\n`)
  stdout.write(`  anti-CSRF (afg)  ${previewSecret(ajaxKey)}\n`)
  stdout.write(`  MFA token sent   ${diagnostics.mfaTokenSentPreview}\n`)
  stdout.write(`  MFA token back   ${diagnostics.mfaTokenReturnedPreview}\n`)
  if (diagnostics.mfaTokenReplaced) {
    stdout.write('  NOTE             Alarm.com returned a DIFFERENT trust token than the one sent.\n')
    stdout.write('                   The supplied token was not accepted for this session.\n')
  }

  if (diagnostics.mfaRequired) {throw new Error('Alarm.com demanded MFA (409). Supply ADC_MFA_TOKEN and retry.')}
  if (!ajaxKey) {
    throw new Error(
      diagnostics.likelyRejected
        ? 'Login was rejected (the form re-rendered instead of redirecting). Check the username and password.'
        : 'Login succeeded but no afg cookie was issued; the session cannot be used.',
    )
  }

  // Read identities with the community client's cookie set, which is the
  // configuration most likely to work, then let the bake-off settle the rest.
  const { status: identityStatus, body: identities } = await authenticatedGet(IDENTITIES_URL, { jar: loginJar, ajaxKey })
  if (identityStatus !== 200) {throw new Error(`identities returned ${identityStatus}; cannot continue.`)}

  const identity = identities.data?.[0]
  const userId = identity?.id
  const systems = (identities.data ?? []).map((entry) => entry.relationships?.selectedSystem?.data?.id).filter(Boolean)

  const scrubber = createScrubber()

  // Shown pseudonymized. Terminal output from this script is exactly what gets
  // pasted into a bug report, and these are the account's real identifiers.
  // The mapping is the one used for the fixtures, so the values printed here
  // still cross-reference the files on disk.
  const shown = scrubber.scrub({ id: userId, systemId: systems })

  stdout.write('\n── Account ──\n')
  stdout.write(`  user id          ${shown.id}\n`)
  stdout.write(`  systems          ${shown.systemId.join(', ') || '(none)'}\n`)
  stdout.write(`  celsius          ${identity?.attributes?.localizeTempUnitsToCelsius}\n`)
  stdout.write(`  logoutTimeoutMs  ${identity?.attributes?.logoutTimeoutMs}\n`)
  stdout.write(`  enableKeepAlive  ${identity?.attributes?.enableKeepAlive}\n`)
  stdout.write('  (identifiers above are pseudonymized, matching the written fixtures)\n')

  await writeFixture('identities.json', scrubber.scrub(identities))

  const context = { userId, systemId: systems[0] }
  const { session, strategy, attempts, hops } = await chooseSessionStrategy(
    { jar, loginJar, ajaxKey },
    systems[0],
    context,
  )
  stdout.write(`  -> using "${strategy}"\n`)

  const authResults = await probeAuthCandidates(session, context, scrubber)

  let inventory = {}
  let sensorSummary = []
  const captureFailures = []
  const collectionStatuses = {}
  for (const systemId of systems) {
    const captured = await captureDevices(session, systemId, scrubber, context)
    inventory = { ...inventory, ...captured.inventory }
    sensorSummary = [...sensorSummary, ...captured.sensorSummary]
    Object.assign(collectionStatuses, captured.collectionStatuses ?? {})
    if (captured.failure) {captureFailures.push(captured.failure)}
  }

  if (sensorSummary.length > 0) {
    stdout.write('\n── Sensor types reported by this panel ──\n')
    for (const entry of sensorSummary) {
      stdout.write(`  deviceType ${String(entry.deviceType).padEnd(4)} x${entry.count}  states=[${entry.states.join(', ')}]`)
      stdout.write(entry.stateTexts.length > 0 ? `  "${entry.stateTexts.join('", "')}"\n` : '\n')
    }
  }

  const events = wsSeconds > 0 ? await listenForEvents(session, wsSeconds) : []
  if (events.length > 0) {await writeFixture('websocket-events.json', scrubber.scrub(events))}

  // Scrubbed like every other artefact. This file aggregates error bodies,
  // redirect hops and capture failures, all of which quote whatever Alarm.com
  // said, and it was the one output written straight through.
  const summary = scrubber.scrub({
    capturedAt: new Date().toISOString(),
    login: diagnostics,
    sessionStrategy: strategy,
    strategyAttempts: attempts,
    warmupHops: hops,
    systemCount: systems.length,
    inventory,
    collectionStatuses,
    captureFailures,
    sensorSummary,
    authCandidates: authResults,
  })

  // Counted after the scrub, so the figure covers this file too.
  await writeFixture('summary.json', { ...summary, identifiersPseudonymized: scrubber.identifierCount })

  stdout.write(`\nWrote scrubbed output to ${OUTPUT_DIR}\n`)
  stdout.write('Review it before sharing: the scrubber is best-effort, not a guarantee.\n')
}

main().catch((error) => {
  process.exitCode = 1
  // Redacted like every other line this script prints: an error can quote a URL
  // or an upstream body, and this output is what gets pasted into an issue.
  stdout.write(`\nError: ${redactFreeText(String(error instanceof Error ? error.message : error))}\n`)
})
