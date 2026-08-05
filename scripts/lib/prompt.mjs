/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Terminal prompts for the development scripts.
 *
 * Secrets are read without echoing, so nothing sensitive lands in the
 * terminal's scrollback or in a shell history file.
 */

import { stdin, stdout } from 'node:process'

/**
 * Raised when stdin closes before an answer arrives.
 *
 * A non-interactive run — CI, `ssh host 'node scripts/probe.mjs'`, a cron
 * wrapper — used to print a prompt, receive EOF, and exit 0 having done
 * nothing, reporting success for a run that never happened.
 */
const NO_INPUT = 'No input available. Set ADC_USERNAME, ADC_PASSWORD, and '
  + 'ADC_MFA_TOKEN when running without a terminal.'

/** Prompt for a value on stdout, echoing what is typed. */
export function promptText(question) {
  return new Promise((resolve, reject) => {
    stdout.write(question)
    stdin.setEncoding('utf8')
    stdin.resume()

    const cleanup = () => {
      stdin.removeListener('data', onData)
      stdin.removeListener('end', onEnd)
      stdin.pause()
    }
    const onData = (chunk) => {
      cleanup()
      resolve(chunk.toString().trim())
    }
    const onEnd = () => {
      cleanup()
      reject(new Error(NO_INPUT))
    }

    stdin.once('data', onData)
    stdin.once('end', onEnd)
  })
}

/** Prompt for a secret without echoing it to the terminal or scrollback. */
export function promptHidden(question) {
  return new Promise((resolve, reject) => {
    stdout.write(question)
    const wasRaw = Boolean(stdin.isRaw)
    if (stdin.isTTY) {
      stdin.setRawMode(true)
    }
    stdin.resume()

    let value = ''
    const cleanup = () => {
      stdin.removeListener('data', onData)
      stdin.removeListener('end', onEnd)
      if (stdin.isTTY) {
        stdin.setRawMode(wasRaw)
      }
      stdin.pause()
    }

    const onData = (chunk) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\r' || character === '\n') {
          cleanup()
          stdout.write('\n')
          resolve(value)
          return
        }
        if (character === '\u0003') {
          cleanup()
          reject(new Error('Aborted'))
          return
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1)
        } else {
          value += character
        }
      }
    }
    const onEnd = () => {
      cleanup()
      reject(new Error(NO_INPUT))
    }

    stdin.on('data', onData)
    stdin.once('end', onEnd)
  })
}

/**
 * Spelled out because the obvious reading is the wrong one: what is needed
 * here is a long browser cookie, not the short code an authenticator shows.
 */
const MFA_PROMPT = [
  '',
  'twoFactorAuthenticationId cookie',
  '  This is NOT the 6-digit code from your authenticator app. It is a long',
  '  opaque string (typically 100+ characters) that Alarm.com leaves in your',
  '  browser once you complete two-factor verification. You do not need to',
  '  mark the device as trusted; the cookie is tied to your account, not to',
  '  a machine, and works from an untrusted host.',
  '',
  '  Browser -> DevTools -> Application (or Storage) -> Cookies -> www.alarm.com',
  '',
  'Paste it (hidden), or leave blank if this account has no 2FA: ',
].join('\n')

/** Read credentials from the environment, prompting for whatever is absent. */
export async function resolveCredentials() {
  const username = process.env.ADC_USERNAME || (await promptText('Alarm.com username: '))
  const password = process.env.ADC_PASSWORD || (await promptHidden('Alarm.com password (hidden): '))
  const mfaToken = process.env.ADC_MFA_TOKEN || (await promptHidden(MFA_PROMPT))

  if (!username || !password) {
    throw new Error('A username and password are required.')
  }

  // Fail fast rather than spending a login to discover that a one-time code
  // was pasted where a cookie belongs.
  if (mfaToken && /^\d{4,8}$/.test(mfaToken.trim())) {
    throw new Error(
      `That value is ${mfaToken.trim().length} digits, which is a one-time code from your authenticator `
        + 'app, not the twoFactorAuthenticationId cookie. See the instructions above the prompt.',
    )
  }

  return { username, password, mfaToken: mfaToken?.trim() || undefined }
}

/**
 * Ask the operator to type an exact word before doing something irreversible.
 *
 * Deliberately not a y/n prompt: this guards commands sent to a live security
 * panel, and reflexively hitting "y" is exactly the failure to prevent.
 */
export async function confirmPhrase(question, phrase) {
  const answer = await promptText(`${question}\nType "${phrase}" to proceed: `)
  return answer === phrase
}
