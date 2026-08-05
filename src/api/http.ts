/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Low-level HTTP transport shared by authentication and the API client.
 */

import { NetworkError, OperationAbortedError, TimeoutError } from '../errors'
import { ALLOWED_API_ORIGIN, DEFAULT_REQUEST_TIMEOUT_MS, PLUGIN_NAME } from '../settings'
import { sanitizeError, sanitizeUrl } from '../utils/sanitizers'
import { PLUGIN_VERSION } from '../utils/version'

/**
 * Identifies the plugin honestly rather than impersonating a browser.
 *
 * Verified acceptable: Alarm.com served the full API surface under this during
 * probe runs. If it ever starts refusing non-browser agents, that is a
 * deliberate signal from them and spoofing it would be the wrong response.
 *
 * The version is read from `package.json` rather than written here. A hardcoded
 * one silently went thirteen releases stale, which defeats the point of
 * identifying honestly and makes a bad release impossible to correlate.
 */
export const USER_AGENT = `${PLUGIN_NAME}/${PLUGIN_VERSION}`

/** Options accepted by {@link httpRequest}, mirroring a subset of `RequestInit`. */
export interface HttpRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string | URLSearchParams
  timeoutMs?: number
  /** Cancels the request, and its body read, on shutdown. */
  signal?: AbortSignal
  /**
   * Redirects are not followed by default.
   *
   * Alarm.com sets session cookies on the 302 hops of the login flow, and the
   * fetch API only exposes `Set-Cookie` from the final response. Following
   * redirects automatically silently discards those cookies.
   */
  redirect?: 'follow' | 'manual' | 'error'
}

/**
 * A completed HTTP exchange, body included.
 *
 * The body is part of the result rather than a promise the caller resolves
 * later, because that is what makes the deadline mean anything: `fetch` settles
 * as soon as headers arrive, so a caller reading `response.text()` afterwards
 * does so with no timeout at all and a stalled body hangs forever.
 */
export interface HttpResponse {
  status: number
  ok: boolean
  headers: Headers
  text: string
}

/**
 * Refuse to send session cookies anywhere but Alarm.com.
 *
 * Today every URL is a compile-time constant and redirects are not followed, so
 * this can never fire. That is precisely why it is here: the safety is
 * currently an emergent property of two unrelated decisions, and a future
 * change to either one should fail loudly rather than quietly replay a live
 * session cookie to a host of someone else's choosing.
 */
function assertCookieDestination(
  url: string,
  headers: Record<string, string>,
  redirect: HttpRequestOptions['redirect'],
): void {
  // Case-insensitive, because `fetch` normalises header names and a caller
  // writing `cookie` would otherwise send the whole session jar with this guard
  // silently skipped — a tripwire that only fires for one spelling is worse
  // than none, because it reads as though it covers both.
  const hasCookie = Object.keys(headers).some((name) => name.toLowerCase() === 'cookie')
  if (!hasCookie) {
    return
  }

  // A followed redirect replays the request, cookies included, at a location the
  // server chose. `fetch` gives no hook to re-check each hop, so the only honest
  // control is to refuse the combination outright.
  if (redirect === 'follow') {
    throw new NetworkError('Refusing to follow redirects on a request carrying session cookies')
  }

  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    throw new NetworkError('Refusing to send session cookies to an unparseable URL')
  }

  if (origin !== ALLOWED_API_ORIGIN) {
    throw new NetworkError(`Refusing to send session cookies to ${sanitizeUrl(url)}`)
  }
}

/**
 * Perform an HTTP request with a hard timeout and consistent identification.
 *
 * @throws {TimeoutError} The request or its body read exceeded the deadline.
 * @throws {OperationAbortedError} The caller's signal aborted the request.
 * @throws {NetworkError} The request failed below the HTTP layer.
 */
export async function httpRequest(
  url: string,
  options: HttpRequestOptions = {},
): Promise<HttpResponse> {
  const { method, headers, body, timeoutMs, signal, redirect } = { ...REQUEST_DEFAULTS, ...options }

  assertCookieDestination(url, headers, redirect)

  if (signal?.aborted === true) {
    throw new OperationAbortedError(`Request to ${sanitizeUrl(url)} was cancelled before it started`)
  }

  const deadline = armDeadline(timeoutMs, signal)

  try {
    const response = await fetch(url, {
      method,
      redirect,
      headers: { 'User-Agent': USER_AGENT, ...headers },
      ...(body === undefined ? {} : { body }),
      signal: deadline.signal,
    })

    // Read inside the deadline. An unconsumed body also holds its connection
    // out of undici's pool until the response is collected, which on a
    // four-minute keep-alive timer accumulates for the process lifetime.
    const text = await response.text()

    return { status: response.status, ok: response.ok, headers: response.headers, text }
  } catch (error) {
    // The cause is carried on every path, not just the network one: it is what
    // `sanitizeError` walks to surface the underlying failure, so dropping it
    // makes the wrapper strictly less useful than what it wrapped.
    const cause = error instanceof Error ? { cause: error } : undefined

    if (deadline.isTimedOut) {
      throw new TimeoutError(`Request to ${sanitizeUrl(url)} timed out after ${timeoutMs}ms`, cause)
    }
    if (deadline.isCancelled) {
      throw new OperationAbortedError(`Request to ${sanitizeUrl(url)} was cancelled`, cause)
    }
    throw new NetworkError(`Request to ${sanitizeUrl(url)} failed: ${sanitizeError(error)}`, cause)
  } finally {
    deadline.release()
  }
}

const REQUEST_DEFAULTS = {
  method: 'GET' as const,
  headers: {} as Record<string, string>,
  body: undefined as string | undefined,
  timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  signal: undefined as AbortSignal | undefined,
  redirect: 'manual' as const,
}

/** A timeout plus caller-cancellation, and which of the two fired. */
interface RequestDeadline {
  readonly signal: AbortSignal
  readonly isTimedOut: boolean
  readonly isCancelled: boolean
  release: () => void
}

/**
 * Arm a request deadline that also relays caller cancellation.
 *
 * Both reasons abort the same controller, and which one fired has to be recorded
 * separately: `fetch` reports every abort identically, so without this a shutdown
 * mid-request is indistinguishable from a timeout — and they are logged and
 * classified differently.
 */
function armDeadline(timeoutMs: number, signal: AbortSignal | undefined): RequestDeadline {
  const controller = new AbortController()
  const state = { isTimedOut: false, isCancelled: false }

  const timer = setTimeout(() => {
    state.isTimedOut = true
    controller.abort()
  }, timeoutMs)

  const abortFromCaller = (): void => {
    state.isCancelled = true
    controller.abort()
  }
  signal?.addEventListener('abort', abortFromCaller, { once: true })

  return {
    signal: controller.signal,
    get isTimedOut() {
      return state.isTimedOut
    },
    get isCancelled() {
      return state.isCancelled
    },
    release: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abortFromCaller)
    },
  }
}
