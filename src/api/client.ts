/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Typed client for the Alarm.com JSON:API surface.
 *
 * Every outbound call passes through pacing, then the circuit breaker, then
 * retry. That order is deliberate: pacing shapes normal traffic, the breaker
 * stops a failing service being hammered, and retry only ever runs inside those
 * two guards so it cannot amplify a problem.
 */

import {
  ApiParseError,
  createApiError,
  SessionExpiredError,
} from '../errors'
import {
  HOME_REFERER,
  IDENTITIES_URL,
  JSON_API_ACCEPT,
  MAX_IDS_PER_REQUEST,
  PARTITIONS_URL,
  SENSORS_URL,
  SYSTEM_URL,
  WEBSOCKET_TOKEN_URL,
} from '../settings'
import type {
  CollectionResponse,
  PartitionAttributes,
  Resource,
  ResourceIdentifier,
  SensorAttributes,
  SingleResponse,
} from '../types/alarm'
import type { Logger } from '../utils/logger'
import { withRetry } from '../utils/retry'
import { sanitizeUrl } from '../utils/sanitizers'
import { CircuitBreaker } from './circuit-breaker'
import { httpRequest } from './http'
import { RateLimiter } from './rate-limiter'
import type { SessionManager } from './session-manager'

/** Arming commands Alarm.com accepts on a partition. */
export type PartitionAction = 'armStay' | 'armAway' | 'disarm'

/** Modifiers that may accompany an arming command. */
export interface PartitionCommandOptions {
  noEntryDelay?: boolean
  silentArming?: boolean
  nightArming?: boolean
  forceBypass?: boolean
}

/** Device identifiers discovered from a system. */
export interface SystemDevices {
  partitionIds: string[]
  sensorIds: string[]
}

/** Credentials for the push event stream. */
export interface EventStreamToken {
  token: string
  /** Endpoint reported by Alarm.com, when it supplies one. */
  endpoint?: string
}

export interface AlarmComClientOptions {
  sessionManager: SessionManager
  log: Logger
  circuitBreaker?: CircuitBreaker
  rateLimiter?: RateLimiter
}

interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
}

/** Split a list into chunks no larger than the API will accept. */
export function chunkIds(ids: readonly string[], size = MAX_IDS_PER_REQUEST): string[][] {
  const chunks: string[][] = []
  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size))
  }
  return chunks
}

/** Build a batched collection URL with `ids[]` parameters. */
function buildBatchUrl(baseUrl: string, ids: readonly string[]): string {
  const params = ids.map((id) => `ids[]=${encodeURIComponent(id)}`).join('&')
  return `${baseUrl}?${params}`
}

/** Extract the linkage list from a JSON:API relationship. */
function readRelationshipIds(
  resource: Resource<unknown> | undefined,
  name: string,
): string[] {
  const data = resource?.relationships?.[name]?.data
  if (!Array.isArray(data)) {
    return data ? [(data as ResourceIdentifier).id] : []
  }
  return data.map((entry) => entry.id)
}

/** Reads and commands Alarm.com devices. */
export class AlarmComClient {
  readonly #sessionManager: SessionManager
  readonly #log: Logger
  readonly #breaker: CircuitBreaker
  readonly #limiter: RateLimiter

  constructor(options: AlarmComClientOptions) {
    this.#sessionManager = options.sessionManager
    this.#log = options.log
    this.#breaker = options.circuitBreaker ?? new CircuitBreaker()
    this.#limiter = options.rateLimiter ?? new RateLimiter()
  }

  /** Issue one authenticated request and parse the JSON:API response. */
  async #send<T>(url: string, options: RequestOptions = {}): Promise<T> {
    const session = await this.#sessionManager.getSession()
    const { method = 'GET', body } = options

    const headers: Record<string, string> = {
      Accept: JSON_API_ACCEPT,
      Cookie: session.cookieHeader,
      ajaxrequestuniquekey: session.ajaxKey,
      Referer: HOME_REFERER,
    }

    if (body !== undefined) {
      headers['Content-Type'] = JSON_API_ACCEPT
    }

    const response = await httpRequest(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    const text = await response.text()

    if (!response.ok) {
      throw createApiError(
        response.status,
        `Alarm.com returned ${response.status} for ${sanitizeUrl(url)}`,
        { body: text },
      )
    }

    try {
      return JSON.parse(text) as T
    } catch (error) {
      // Alarm.com serves an HTML login page rather than a JSON error when a
      // session lapses, so an unparseable body usually means "sign in again".
      throw new ApiParseError(
        `Alarm.com returned a non-JSON response for ${sanitizeUrl(url)}; the session may have expired`,
        error instanceof Error ? { cause: error } : undefined,
      )
    }
  }

  /**
   * Send a request under pacing, the circuit breaker, and retry.
   *
   * A lapsed session is retried exactly once with a fresh login. Beyond that it
   * propagates, because repeatedly re-authenticating against a service that
   * keeps rejecting us is how accounts get locked.
   */
  async #request<T>(url: string, options: RequestOptions = {}): Promise<T> {
    const attempt = (): Promise<T> =>
      this.#limiter.execute(() => this.#breaker.execute(() => this.#send<T>(url, options)))

    return withRetry(
      async () => {
        try {
          return await attempt()
        } catch (error) {
          // A lapsed session announces itself two ways: a 401, and an HTTP 200
          // carrying the HTML login page, which fails to parse. Treating only
          // the 401 as expiry meant the HTML case kept reusing dead cookies
          // until the auth interval elapsed, turning a one-request recovery
          // into minutes of failing polls.
          if (error instanceof SessionExpiredError || error instanceof ApiParseError) {
            this.#log.debug('session rejected; re-authenticating once before giving up')
            this.#sessionManager.invalidate()
            return attempt()
          }
          throw error
        }
      },
      {
        onRetry: (attemptNumber, delayMs, error) => {
          this.#log.debug(
            `retrying ${sanitizeUrl(url)} (attempt ${attemptNumber}) in ${delayMs}ms after ${String(error)}`,
          )
        },
      },
    )
  }

  /** Resolve the system this account has selected. */
  async getSystemId(): Promise<string> {
    const response = await this.#request<CollectionResponse<unknown>>(IDENTITIES_URL)
    const identity = response.data?.[0]
    const selected = identity?.relationships?.selectedSystem?.data

    if (!selected || Array.isArray(selected)) {
      throw new ApiParseError('Alarm.com did not report a selected system for this account')
    }

    return selected.id
  }

  /** List the partition and sensor IDs belonging to a system. */
  async getSystemDevices(systemId: string): Promise<SystemDevices> {
    const url = `${SYSTEM_URL}${encodeURIComponent(systemId)}`
    const response = await this.#request<SingleResponse<unknown>>(url)

    return {
      partitionIds: readRelationshipIds(response.data, 'partitions'),
      sensorIds: readRelationshipIds(response.data, 'sensors'),
    }
  }

  /** Fetch a collection in batches the API will accept. */
  async #getBatched<T>(baseUrl: string, ids: readonly string[]): Promise<Resource<T>[]> {
    if (ids.length === 0) {
      return []
    }

    const results: Resource<T>[] = []

    // Sequential, not parallel: concurrent bursts are what the pacing exists to
    // prevent, and discovery is not latency-sensitive.
    for (const chunk of chunkIds(ids)) {
      const response = await this.#request<CollectionResponse<T>>(buildBatchUrl(baseUrl, chunk))
      results.push(...(response.data ?? []))
    }

    return results
  }

  async getSensors(ids: readonly string[]): Promise<Resource<SensorAttributes>[]> {
    return this.#getBatched<SensorAttributes>(SENSORS_URL, ids)
  }

  async getPartitions(ids: readonly string[]): Promise<Resource<PartitionAttributes>[]> {
    return this.#getBatched<PartitionAttributes>(PARTITIONS_URL, ids)
  }

  /**
   * Send an arming command to a partition.
   *
   * Modifiers are omitted rather than sent as `false` where Alarm.com is known
   * to reject them: `nightArming` and `forceBypass` break the command outright
   * on panels that do not support them, and neither applies to a disarm.
   *
   * Not wrapped in retry. Arming is not idempotent from the user's point of
   * view — a duplicate command can produce a second exit-delay countdown — so a
   * failure is reported rather than silently repeated.
   */
  async commandPartition(
    partitionId: string,
    action: PartitionAction,
    options: PartitionCommandOptions = {},
  ): Promise<Resource<PartitionAttributes>> {
    const url = `${PARTITIONS_URL}/${encodeURIComponent(partitionId)}/${action}`
    const isDisarm = action === 'disarm'

    const body: Record<string, boolean> = { statePollOnly: false }

    if (!isDisarm) {
      body.noEntryDelay = Boolean(options.noEntryDelay)
      body.silentArming = Boolean(options.silentArming)
      if (options.nightArming) {
        body.nightArming = true
      }
      if (options.forceBypass) {
        body.forceBypass = true
      }
    }

    this.#log.info(`Sending "${action}" to partition ${partitionId}`)

    const response = await this.#limiter.execute(() =>
      this.#breaker.execute(() =>
        this.#send<SingleResponse<PartitionAttributes>>(url, { method: 'POST', body }),
      ),
    )

    return response.data
  }

  /**
   * Obtain a short-lived token for the push event stream.
   *
   * This endpoint answers with a flat object rather than a JSON:API document,
   * unlike every other route on this surface.
   */
  async getEventStreamToken(): Promise<EventStreamToken> {
    const response = await this.#request<{
      value?: string
      metaData?: { endpoint?: string }
    }>(WEBSOCKET_TOKEN_URL)

    if (!response.value) {
      throw new ApiParseError('Alarm.com did not return an event stream token')
    }

    // The endpoint is nested under metaData, not alongside the token.
    const endpoint = response.metaData?.endpoint

    return endpoint
      ? { token: response.value, endpoint }
      : { token: response.value }
  }

  /** Diagnostics for the resilience layers. */
  getStatus(): Record<string, unknown> {
    return {
      circuitBreaker: this.#breaker.getStatus(),
      rateLimiter: this.#limiter.getStatus(),
      hasSession: this.#sessionManager.hasSession,
    }
  }
}
