#!/usr/bin/env node
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview One-shot diagnosis of why the event stream will not connect.
 *
 * The probe connected to Alarm.com's event stream successfully using Node's
 * built-in WebSocket with the token appended raw. The plugin uses the `ws`
 * package and was percent-encoding the token. Either difference could explain
 * a refused upgrade, and guessing costs a round trip with the user each time.
 *
 * So this tries every combination at once and reports which ones connect.
 * Read-only: it opens sockets and closes them.
 *
 * Usage: node scripts/diagnose-stream.mjs [--verbose]
 *
 * Requires a build: run "npm run build" first, or use "npm run diagnose-stream".
 */

import { createRequire } from 'node:module'
import { stdout } from 'node:process'
import { join } from 'node:path'

import WsPackage from 'ws'
import { handleHelp, hasFlag } from './lib/cli.mjs'
import { createTerminalLogger, DIST_DIR, requireBuild } from './lib/plugin-logger.mjs'
import { resolveCredentials } from './lib/prompt.mjs'
import { redactFreeText } from './lib/scrub.mjs'
import { isWebSocketUrl } from './lib/session.mjs'

handleHelp(`
Diagnose why the Alarm.com event stream will not connect.

  node scripts/diagnose-stream.mjs [--verbose]

Opens and immediately closes one socket per client/encoding combination and
reports which ones the server accepts. Read-only; it sends no commands.

  --verbose   Include the plugin's debug lines.
  -h, --help  Show this message.

Credentials come from ADC_USERNAME, ADC_PASSWORD, and ADC_MFA_TOKEN, or are
prompted for when a terminal is attached.
`)

requireBuild()

const require = createRequire(import.meta.url)
const { lengthBand, sanitizeString } = require(join(DIST_DIR, 'utils/sanitizers.js'))
const { SessionManager } = require(join(DIST_DIR, 'api/session-manager.js'))
const { AlarmComClient } = require(join(DIST_DIR, 'api/client.js'))

const ATTEMPT_TIMEOUT_MS = 12_000

/** Fallback endpoint, matching the plugin's own default. */
const DEFAULT_ENDPOINT = 'wss://webskt.alarm.com:8443'

const log = createTerminalLogger('diagnose', hasFlag('--verbose'))

/**
 * Render a socket failure so it cannot carry the token it was authenticating with.
 *
 * This is the one place the whole script exists to reach, and it is also where
 * `ws` is least careful: a malformed endpoint is reported as
 * `SyntaxError: Invalid URL: wss://…?auth=<the live token>`. The redacting
 * logger covers the plugin components this script drives, but not the sockets
 * it opens itself.
 */
function describeFailure(error) {
  return redactFreeText(sanitizeString(String(error?.message ?? error)))
}

/**
 * Try one client/encoding combination and resolve with what happened.
 *
 * Never rejects: a failure is a result here, not an error.
 */
function attempt(label, makeSocket) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome, detail) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      try {
        socket?.close()
      } catch {
        // Closing a socket that never opened is fine.
      }
      resolve({ label, outcome, detail })
    }

    const timer = setTimeout(() => finish('TIMEOUT', `no response in ${ATTEMPT_TIMEOUT_MS}ms`), ATTEMPT_TIMEOUT_MS)

    let socket
    try {
      socket = makeSocket()
    } catch (error) {
      finish('THREW', describeFailure(error))
      return
    }

    // The `ws` package uses EventEmitter; the built-in uses EventTarget. Wire
    // up whichever this socket actually supports.
    if (typeof socket.on === 'function') {
      socket.on('open', () => finish('CONNECTED', 'upgrade accepted'))
      socket.on('unexpected-response', (_req, res) => finish('REFUSED', `HTTP ${res.statusCode}`))
      socket.on('error', (error) => finish('ERROR', describeFailure(error)))
      socket.on('close', (code) => finish('CLOSED', `close code ${code}`))
      return
    }

    socket.addEventListener('open', () => finish('CONNECTED', 'upgrade accepted'))
    socket.addEventListener('error', () => finish('ERROR', 'connection error (built-in client hides the status)'))
    socket.addEventListener('close', (event) => finish('CLOSED', `close code ${event.code}`))
  })
}

async function main() {
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

  stdout.write('\n── Token ──\n')
  const { token, endpoint } = await client.getEventStreamToken()

  // The endpoint is one field in a server response, and the token is appended
  // to it. Unchecked, whoever controls that field controls where a live
  // credential for a home security system is sent — and a `ws://` value would
  // send it in clear text. The plugin refuses such an endpoint; so must this.
  const target = endpoint && isWebSocketUrl(endpoint) ? endpoint : DEFAULT_ENDPOINT
  if (endpoint && target !== endpoint) {
    stdout.write('  ! Ignoring a reported endpoint that is not secure alarm.com; using the default.\n')
  }

  stdout.write(`  endpoint reported   ${endpoint ?? '(none; using the default)'}\n`)
  // Banded, not exact. This output is pasted into issues by definition, and the
  // precise length of a live credential is one more fact an attacker holding the
  // paste would not otherwise have. A band answers the diagnostic question
  // ("did we get a token, and is it plausibly whole?") without publishing it.
  stdout.write(`  token length        ${lengthBand(token.length)}\n`)
  // Whether the token needs encoding at all is the crux, so report it plainly.
  const encoded = encodeURIComponent(token)
  stdout.write(`  encoding changes it ${encoded !== token}\n`)
  if (encoded !== token) {
    const changed = [...new Set([...token].filter((c) => encodeURIComponent(c) !== c))]
    stdout.write(`  characters affected ${JSON.stringify(changed)}\n`)
  }

  stdout.write('\n── Connection attempts ──\n')

  const BuiltIn = globalThis.WebSocket
  const combinations = [
    ['ws package     + raw token', () => new WsPackage(`${target}?auth=${token}`)],
    ['ws package     + encoded  ', () => new WsPackage(`${target}?auth=${encoded}`)],
  ]

  if (BuiltIn) {
    combinations.push(
      ['built-in       + raw token', () => new BuiltIn(`${target}?auth=${token}`)],
      ['built-in       + encoded  ', () => new BuiltIn(`${target}?auth=${encoded}`)],
    )
  } else {
    stdout.write('  (this Node build has no global WebSocket; skipping those two)\n')
  }

  // Sequential, not parallel: several simultaneous upgrade attempts against a
  // security provider is exactly the traffic pattern to avoid.
  for (const [label, makeSocket] of combinations) {
    const result = await attempt(label, makeSocket)
    const marker = result.outcome === 'CONNECTED' ? '✓' : '✗'
    stdout.write(`  ${marker} ${result.label}  ${result.outcome}: ${result.detail}\n`)
  }

  stdout.write('\nIf exactly one column works, that is the answer and the plugin will be changed to match.\n')
  process.exit(0)
}

main().catch((error) => {
  stdout.write(`\nFailed: ${describeFailure(error)}\n`)
  process.exit(1)
})
