/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Low-level HTTP transport shared by authentication and the API client.
 */

import { NetworkError, TimeoutError } from '../errors'
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../settings'
import { sanitizeError, sanitizeUrl } from '../utils/sanitizers'

/**
 * Identifies the plugin honestly rather than impersonating a browser.
 *
 * Verified acceptable: Alarm.com served the full API surface under this during
 * probe runs. If it ever starts refusing non-browser agents, that is a
 * deliberate signal from them and spoofing it would be the wrong response.
 */
export const USER_AGENT = 'homebridge-myalarmcom/0.1.0'

/** Options accepted by {@link httpRequest}, mirroring a subset of `RequestInit`. */
export interface HttpRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string | URLSearchParams
  timeoutMs?: number
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
 * Perform an HTTP request with a hard timeout and consistent identification.
 *
 * @throws {TimeoutError} The request exceeded its deadline.
 * @throws {NetworkError} The request failed below the HTTP layer.
 */
export async function httpRequest(
  url: string,
  options: HttpRequestOptions = {},
): Promise<Response> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    redirect = 'manual',
  } = options

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, {
      method,
      redirect,
      headers: { 'User-Agent': USER_AGENT, ...headers },
      body,
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new TimeoutError(`Request to ${sanitizeUrl(url)} timed out after ${timeoutMs}ms`)
    }
    throw new NetworkError(
      `Request to ${sanitizeUrl(url)} failed: ${sanitizeError(error)}`,
      error instanceof Error ? { cause: error } : undefined,
    )
  } finally {
    clearTimeout(timer)
  }
}
