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
 * Usage: node scripts/diagnose-stream.mjs
 */

import { createRequire } from 'node:module'
import { stdout } from 'node:process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

import WsPackage from 'ws'
import { resolveCredentials } from './lib/prompt.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const distDir = join(here, '..', 'dist')
const require = createRequire(import.meta.url)

if (!existsSync(join(distDir, 'index.js'))) {
  stdout.write('dist/ is missing. Run "npm run build" first.\n')
  process.exit(1)
}

const { SessionManager } = require(join(distDir, 'api/session-manager.js'))
const { AlarmComClient } = require(join(distDir, 'api/client.js'))

const ATTEMPT_TIMEOUT_MS = 12_000

const quietLog = {
  debug: () => undefined,
  info: (message) => stdout.write(`  · ${message}\n`),
  warn: (message) => stdout.write(`  ! ${message}\n`),
  error: (message) => stdout.write(`  ✗ ${message}\n`),
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
      finish('THREW', error?.message ?? String(error))
      return
    }

    // The `ws` package uses EventEmitter; the built-in uses EventTarget. Wire
    // up whichever this socket actually supports.
    if (typeof socket.on === 'function') {
      socket.on('open', () => finish('CONNECTED', 'upgrade accepted'))
      socket.on('unexpected-response', (_req, res) => finish('REFUSED', `HTTP ${res.statusCode}`))
      socket.on('error', (error) => finish('ERROR', error?.message ?? String(error)))
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
    log: quietLog,
  })
  const client = new AlarmComClient({ sessionManager, log: quietLog })

  stdout.write('\n── Token ──\n')
  const { token, endpoint } = await client.getEventStreamToken()
  const target = endpoint ?? 'wss://webskt.alarm.com:8443'

  stdout.write(`  endpoint reported   ${endpoint ?? '(none; using the default)'}\n`)
  stdout.write(`  token length        ${token.length}\n`)
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
  stdout.write(`\nFailed: ${error?.message ?? error}\n`)
  process.exit(1)
})
