/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Typed client for the Alarm.com JSON:API surface.
 *
 * Every attempt passes through pacing and then the circuit breaker. Retry wraps
 * the whole thing, so a retried attempt is re-paced and re-checked against the
 * breaker rather than bypassing them — which is what stops retry amplifying a
 * problem. Session establishment sits outside all three: it has its own floor,
 * and counting a login as request latency made the reported percentiles
 * meaningless.
 */

import {
  AlarmComError,
  ApiParseError,
  CircuitBreakerError,
  createApiError,
  LoginThrottledError,
  parseRetryAfterMs,
  RequestPacingError,
  SessionExpiredError,
  SystemUnavailableError,
} from '../errors'
import {
  CSRF_HEADER_NAME,
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
  EventStreamToken,
  PartitionAction,
  PartitionAttributes,
  Resource,
  ResourceIdentifier,
  SensorAttributes,
  SingleResponse,
} from '../types/alarm'
import type { Logger } from '../utils/logger'
import { withRetry } from '../utils/retry'
import { sanitizeError, sanitizeUrl } from '../utils/sanitizers'
import type { Session } from './auth'
import { CircuitBreaker, CircuitState } from './circuit-breaker'
import { httpRequest } from './http'
import { RateLimiter } from './rate-limiter'
import type { SessionManager } from './session-manager'

export type { EventStreamToken, PartitionAction }

/** One timed API call outcome for diagnostics. */
export interface ApiRequestMetric {
  durationMs: number
  isOk: boolean
  /** False when the call never reached the network (breaker open, rate limited). */
  wasNetworked: boolean
}

/**
 * Modifiers that may accompany an arming command.
 *
 * Only the two HomeKit can actually express. `noEntryDelay` and `silentArming`
 * were also declared here and read into the request body, but nothing could ever
 * set them — HomeKit has no vocabulary for either, so the plugin would have been
 * choosing them on the user's behalf. They are still sent as `false`, because
 * that is what the observed protocol expects, but they are no longer pretended
 * to be options.
 */
export interface PartitionCommandOptions {
  nightArming?: boolean
  forceBypass?: boolean
}

/** Device identifiers discovered from a system. */
export interface SystemDevices {
  partitionIds: string[]
  sensorIds: string[]
}

/** Health of the resilience layers, as reported by {@link AlarmComClient.getStatus}. */
export interface ClientStatus {
  circuitBreaker: { state: CircuitState }
  rateLimiter: { remaining: number }
  hasSession: boolean
}

export interface AlarmComClientOptions {
  sessionManager: SessionManager
  log: Logger
  circuitBreaker?: CircuitBreaker
  rateLimiter?: RateLimiter
  /** Called after every request attempt, for diagnostics. */
  metrics?: (sample: ApiRequestMetric) => void
  /** Called when the circuit breaker opens. */
  onCircuitOpen?: () => void
  /** Called when pacing refuses a request because the wait would be too long. */
  onThrottle?: () => void
  /** Called when a transient failure is about to be retried. */
  onRetry?: () => void
  /** Cancels in-flight requests and pending waits when the platform shuts down. */
  signal?: AbortSignal
}

interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  /** Correlation tag, so every line about one request can be tied together. */
  tag?: string
  /**
   * Cancels this call specifically, in addition to shutdown.
   *
   * Used by the poll cycle, whose own deadline has to be able to stop the work
   * it started rather than merely stop waiting for it.
   */
  signal?: AbortSignal
}

/** Width of a correlation tag: short enough to scan, wide enough not to collide. */
const REQUEST_TAG_HEX_DIGITS = 6

/**
 * A short tag identifying one logical request.
 *
 * Alarm.com is polled every interval and each poll is several requests, so a
 * log can hold thousands of near-identical lines a day. Without a tag there is
 * no way to tell which retry, which session recovery, and which failure belong
 * to the same request. Six hex characters is plenty to disambiguate within one
 * log; it is not an identifier anything depends on.
 */
function nextRequestTag(): string {
  const value = Math.floor(Math.random() * 16 ** REQUEST_TAG_HEX_DIGITS)
  return value.toString(16).padStart(REQUEST_TAG_HEX_DIGITS, '0')
}

/** Split a list into chunks no larger than the API will accept. */
function chunkIds(ids: readonly string[], size = MAX_IDS_PER_REQUEST): string[][] {
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

/** Whether a JSON:API linkage carries a usable resource id. */
function isUsableId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Both ways a lapsed session announces itself. Safe to replay a *read* on. */
function isLapsedSession(error: unknown): boolean {
  return error instanceof SessionExpiredError || error instanceof ApiParseError
}

/**
 * The only failure a non-idempotent write may be replayed on.
 *
 * A 401 means the request was rejected outright, so a replay sends the command
 * for the first time. Nothing else qualifies.
 */
function isRejectedOutright(error: unknown): boolean {
  return error instanceof SessionExpiredError
}

/**
 * Extract the linkage list from a JSON:API relationship.
 *
 * Ids are filtered rather than trusted. Responses are parsed without runtime
 * validation, and a malformed linkage previously produced `[undefined]`, which
 * became the literal query parameter `ids[]=undefined` and a handler keyed on
 * the string `"undefined"`.
 */
function readRelationshipIds(
  resource: Resource<unknown> | undefined,
  name: string,
): string[] {
  const data = resource?.relationships?.[name]?.data

  const identifiers: readonly Partial<ResourceIdentifier>[] = Array.isArray(data)
    ? data
    : data
      ? [data]
      : []

  return identifiers.map((entry) => entry.id).filter(isUsableId)
}

/** Reads and commands Alarm.com devices. */
export class AlarmComClient {
  readonly #sessionManager: SessionManager
  readonly #log: Logger
  readonly #breaker: CircuitBreaker
  readonly #limiter: RateLimiter
  readonly #metrics: ((sample: ApiRequestMetric) => void) | undefined
  readonly #onThrottle: (() => void) | undefined
  readonly #onRetry: (() => void) | undefined
  readonly #signal: AbortSignal | undefined
  /** Whether the current outage has already been announced. */
  #hasReportedCircuitOpen = false

  constructor(options: AlarmComClientOptions) {
    this.#sessionManager = options.sessionManager
    this.#log = options.log
    this.#metrics = options.metrics
    this.#onThrottle = options.onThrottle
    this.#onRetry = options.onRetry
    this.#signal = options.signal
    this.#breaker = options.circuitBreaker ?? new CircuitBreaker()
    this.#breaker.attachOnStateChange((from, to) => {
      // Once per outage, not once per probe cycle. The breaker re-opens after
      // every failed half-open probe, so counting each as a trip reported 1,440
      // of them for a single day-long outage.
      const isNewOutage = to === CircuitState.OPEN && !this.#hasReportedCircuitOpen
      this.#logCircuitTransition(from, to)
      if (isNewOutage) {
        options.onCircuitOpen?.()
      }
    })
    this.#limiter = options.rateLimiter ?? new RateLimiter()
  }

  /**
   * Surface circuit-breaker transitions as bare `from -> to` lines.
   *
   * Only the edges into and out of "unavailable" are loud. During an outage the
   * breaker necessarily flaps OPEN -> HALF_OPEN -> OPEN once per poll cycle as
   * the cooldown elapses and the probe fails, which at the default interval was
   * 2,880 lines a day — arriving at warn level, in the log an operator is
   * scrolling to understand the outage, burying the one line that explains it.
   */
  #logCircuitTransition(from: CircuitState, to: CircuitState): void {
    const message = `Circuit breaker ${from} -> ${to}`

    if (to === CircuitState.OPEN && !this.#hasReportedCircuitOpen) {
      this.#hasReportedCircuitOpen = true
      this.#log.warn(message)
      return
    }

    if (to === CircuitState.CLOSED && this.#hasReportedCircuitOpen) {
      this.#hasReportedCircuitOpen = false
      this.#log.info(message)
      return
    }

    this.#log.debug(message)
  }

  /**
   * Issue one authenticated request and parse the JSON:API response.
   *
   * Takes the session rather than resolving it, so establishing one — which can
   * wait on the login floor, and is two requests of its own — is neither timed
   * as request latency nor charged against the pacing budget for this call.
   */
  async #send<T>(session: Session, url: string, options: RequestOptions = {}): Promise<T> {
    const { method = 'GET', body, tag = nextRequestTag(), signal = this.#signal } = options

    const headers: Record<string, string> = {
      Accept: JSON_API_ACCEPT,
      Cookie: session.cookieHeader,
      [CSRF_HEADER_NAME]: session.ajaxKey,
      Referer: HOME_REFERER,
    }

    if (body !== undefined) {
      headers['Content-Type'] = JSON_API_ACCEPT
    }

    const startedAt = Date.now()
    const response = await httpRequest(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    })
    const durationMs = Date.now() - startedAt

    if (!response.ok) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
      throw createApiError(
        response.status,
        `Alarm.com returned ${response.status} for ${sanitizeUrl(url)} [${tag}, ${durationMs}ms]`,
        {
          body: response.text,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        },
      )
    }

    this.#log.debug(`${method} ${sanitizeUrl(url)} -> ${response.status} [${tag}, ${durationMs}ms]`)

    try {
      return JSON.parse(response.text) as T
    } catch (error) {
      // Alarm.com serves an HTML login page rather than a JSON error when a
      // session lapses, so an unparseable body usually means "sign in again".
      throw new ApiParseError(
        `Alarm.com returned a non-JSON response for ${sanitizeUrl(url)} [${tag}]; the session may have expired`,
        error instanceof Error ? { cause: error } : undefined,
      )
    }
  }

  /**
   * One guarded attempt: timed, paced, and behind the circuit breaker.
   *
   * The session is resolved first and outside all three, so a login's own two
   * requests and any login-floor wait are not attributed to this call.
   */
  #guardedAttempt<T>(url: string, options: RequestOptions): () => Promise<T> {
    const signal = options.signal ?? this.#signal

    return async () => {
      const session = await this.#sessionManager.getSession()

      return this.#timedAttempt(() =>
        this.#limiter.execute(
          () => this.#breaker.execute(() => this.#send<T>(session, url, options)),
          signal,
        ))
    }
  }

  /**
   * Run an attempt, recovering from a lapsed session exactly once.
   *
   * Beyond one recovery it propagates, because repeatedly re-authenticating
   * against a service that keeps rejecting us is how accounts get locked.
   *
   * A lapsed session announces itself two ways: a 401, and an HTTP 200 carrying
   * the HTML login page, which fails to parse. Treating only the 401 as expiry
   * meant the HTML case kept reusing dead cookies until the auth interval
   * elapsed, turning a one-request recovery into minutes of failing polls.
   *
   * @param isReplayable Which failures may be retried. A read may replay on
   *   either signal. A *write* may only replay on the 401: an `ApiParseError` is
   *   thrown after `response.ok`, so it means the panel very likely accepted the
   *   command and Alarm.com answered with an interstitial — replaying it sends a
   *   second arm.
   */
  async #withSessionRecovery<T>(
    attempt: () => Promise<T>,
    context: string,
    isReplayable: (error: unknown) => boolean = isLapsedSession,
  ): Promise<T> {
    try {
      return await attempt()
    } catch (error) {
      if (isReplayable(error)) {
        this.#log.debug(`session rejected ${context}: re-authenticating once before giving up`)
        this.#sessionManager.invalidate()
        return attempt()
      }
      throw error
    }
  }

  /**
   * Whether a failure is worth another generic attempt.
   *
   * Narrower than {@link AlarmComError.isRetryable}, which answers "may this
   * clear on its own?". Three exclusions, each for its own reason:
   *
   * - Session lapses have their own one-shot recovery above, and must not also
   *   be retried three times.
   * - An open circuit must fail fast rather than burn paced attempts against a
   *   service already known to be unavailable.
   * - A login throttle carries a wait of up to the whole re-auth interval.
   *   Retrying sleeps it inline, which is exactly what the session manager's
   *   inline-wait cap exists to prevent; the next poll is the right place to
   *   try again.
   */
  static #isWorthRetrying(error: unknown): boolean {
    if (
      isLapsedSession(error)
      || error instanceof CircuitBreakerError
      || error instanceof LoginThrottledError
    ) {
      return false
    }
    return error instanceof AlarmComError && error.isRetryable
  }

  /** Send a request under pacing, the circuit breaker, and retry. */
  async #request<T>(url: string, options: RequestOptions = {}): Promise<T> {
    const tag = options.tag ?? nextRequestTag()
    const signal = options.signal ?? this.#signal
    const attempt = this.#guardedAttempt<T>(url, { ...options, tag })

    return withRetry(
      () => this.#withSessionRecovery(attempt, `[${tag}]`),
      {
        isRetryable: AlarmComClient.#isWorthRetrying,
        onRetry: (attemptNumber, delayMs, error) => {
          this.#onRetry?.()
          this.#log.debug(
            `retrying ${sanitizeUrl(url)} [${tag}] (attempt ${attemptNumber}) in ${delayMs}ms after ${sanitizeError(error)}`,
          )
        },
        ...(signal ? { signal } : {}),
      },
    )
  }

  /**
   * Time one attempt and feed the outcome to diagnostics.
   *
   * Pre-flight rejections (open breaker, pacing refusal) are recorded as
   * non-networked so they do not skew latency percentiles.
   */
  async #timedAttempt<T>(operation: () => Promise<T>): Promise<T> {
    const started = Date.now()
    try {
      const result = await operation()
      this.#metrics?.({ durationMs: Date.now() - started, isOk: true, wasNetworked: true })
      return result
    } catch (error) {
      const isThrottle = error instanceof RequestPacingError
      const isBreaker = error instanceof CircuitBreakerError

      if (isThrottle) {
        this.#onThrottle?.()
      }

      this.#metrics?.({
        durationMs: Date.now() - started,
        isOk: false,
        wasNetworked: !isThrottle && !isBreaker,
      })
      throw error
    }
  }

  /** Resolve the system this account has selected. */
  async getSystemId(signal?: AbortSignal): Promise<string> {
    const response = await this.#request<CollectionResponse<unknown>>(
      IDENTITIES_URL,
      signal ? { signal } : {},
    )
    const identity = response.data?.[0]
    const selected = identity?.relationships?.selectedSystem?.data

    if (!selected || Array.isArray(selected) || !isUsableId(selected.id)) {
      // Distinct from ConfigurationError, which means the *user's* config is
      // wrong and only they can fix it. This is Alarm.com not reporting a
      // system, which is usually an account setup problem but is also what a
      // partial response looks like — so it is retried on a backoff instead of
      // permanently ending startup.
      throw new SystemUnavailableError(
        'Alarm.com did not report a selected system for this account',
      )
    }

    return selected.id
  }

  /** List the partition and sensor IDs belonging to a system. */
  async getSystemDevices(systemId: string, signal?: AbortSignal): Promise<SystemDevices> {
    const url = `${SYSTEM_URL}${encodeURIComponent(systemId)}`
    const response = await this.#request<SingleResponse<unknown>>(url, signal ? { signal } : {})

    return {
      partitionIds: readRelationshipIds(response.data, 'partitions'),
      sensorIds: readRelationshipIds(response.data, 'sensors'),
    }
  }

  /** Fetch a collection in batches the API will accept. */
  async #getBatched<T>(
    baseUrl: string,
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<Resource<T>[]> {
    if (ids.length === 0) {
      return []
    }

    const results: Resource<T>[] = []

    // Sequential, not parallel: concurrent bursts are what the pacing exists to
    // prevent, and discovery is not latency-sensitive.
    for (const chunk of chunkIds(ids)) {
      const response = await this.#request<CollectionResponse<T>>(
        buildBatchUrl(baseUrl, chunk),
        signal ? { signal } : {},
      )
      results.push(...(response.data ?? []))
    }

    return results
  }

  /** Read the current state of the given sensors. */
  async getSensors(
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<Resource<SensorAttributes>[]> {
    return this.#getBatched<SensorAttributes>(SENSORS_URL, ids, signal)
  }

  /** Read the current state of the given partitions. */
  async getPartitions(
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<Resource<PartitionAttributes>[]> {
    return this.#getBatched<PartitionAttributes>(PARTITIONS_URL, ids, signal)
  }

  /**
   * Send an arming command to a partition.
   *
   * Modifiers are omitted rather than sent as `false` where Alarm.com is known
   * to reject them: `nightArming` and `forceBypass` break the command outright
   * on panels that do not support them, and neither applies to a disarm.
   *
   * Not wrapped in {@link withRetry}: arming is not idempotent from the user's
   * point of view — a duplicate command can produce a second exit-delay
   * countdown. A lapsed session is still recovered once (invalidate + one
   * retry), matching read paths, so dead cookies do not fail a user command
   * that the next poll would have survived.
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
      // Always present and always false: the arming endpoint expects both keys,
      // and neither corresponds to anything a HomeKit client can ask for.
      body.noEntryDelay = false
      body.silentArming = false
      if (options.nightArming) {
        body.nightArming = true
      }
      if (options.forceBypass) {
        body.forceBypass = true
      }
    }

    const tag = nextRequestTag()
    this.#log.debug(`Sending "${action}" to partition ${partitionId} [${tag}]`)

    const attempt = this.#guardedAttempt<SingleResponse<PartitionAttributes>>(url, {
      method: 'POST',
      body,
      tag,
    })

    const response = await this.#withSessionRecovery(
      attempt,
      `during command [${tag}]`,
      isRejectedOutright,
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
  getStatus(): ClientStatus {
    return {
      circuitBreaker: { state: this.#breaker.getStatus().state },
      rateLimiter: { remaining: this.#limiter.getStatus().remaining },
      hasSession: this.#sessionManager.hasSession,
    }
  }
}
