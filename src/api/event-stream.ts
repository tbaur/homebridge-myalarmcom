/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Push event stream over WebSocket.
 *
 * Alarm.com pushes panel and sensor activity over a WebSocket authenticated by
 * a short-lived token. The stream is treated strictly as a *hint*: an event
 * tells the platform which device changed, and the platform then re-reads that
 * device's real state. Decoding each event's payload into a state would mean
 * depending on several hundred undocumented event codes, and being wrong about
 * one of them in a security integration is not an acceptable failure mode.
 */

import WebSocket from 'ws'
import {
  DEFAULT_WEBSOCKET_ENDPOINT,
  WEBSOCKET_HANDSHAKE_TIMEOUT_MS,
  WEBSOCKET_HOST_SUFFIX,
  WEBSOCKET_MAX_FAILURES,
  WEBSOCKET_RECONNECT_BASE_MS,
  WEBSOCKET_RECONNECT_MAX_MS,
  WEBSOCKET_RECOVERY_INTERVAL_MS,
  WEBSOCKET_REFRESH_INTERVAL_MS,
  WEBSOCKET_REFRESH_JITTER_MS,
} from '../settings'
import { EVENT_TYPE_USER_LOGGED_IN, type AlarmComEvent } from '../types/events'
import type { Logger } from '../utils/logger'
import { computeBackoffMs } from '../utils/retry'
import type { EventStreamToken } from './client'

export type { AlarmComEvent }

export interface EventStreamOptions {
  log: Logger
  /** Fetches a fresh token and endpoint. Called on every (re)connect. */
  requestToken: () => Promise<EventStreamToken>
  /** Invoked with the resource ID of the device an event concerns. */
  onDeviceEvent: (deviceResourceId: string, event: AlarmComEvent) => void
  /** Invoked when the stream gives up, so the caller can lean on polling. */
  onUnavailable: () => void
  /** Invoked when the stream reconnects after a prior disconnect. */
  onReconnect?: () => void
  /** Invoked when the stream resumes after a prior give-up. */
  onRecovered?: () => void
}

/** Live status of the event stream, for diagnostics. */
export interface EventStreamStatus {
  isConnected: boolean
  isConnecting: boolean
  isClosed: boolean
  lastEventAgeSec: number | null
}

/** Maintains a live connection to the Alarm.com event stream. */
export class EventStream {
  readonly #log: Logger
  readonly #requestToken: () => Promise<EventStreamToken>
  readonly #onDeviceEvent: (deviceResourceId: string, event: AlarmComEvent) => void
  readonly #onUnavailable: () => void
  readonly #onReconnect?: () => void
  readonly #onRecovered?: () => void

  #socket: WebSocket | null = null
  #reconnectTimer: NodeJS.Timeout | null = null
  #refreshTimer: NodeJS.Timeout | null = null
  #recoveryTimer: NodeJS.Timeout | null = null
  #consecutiveFailures = 0
  #isStopped = false
  /** Whether a failure reason has already been surfaced at warn level. */
  #hasReportedFailure = false
  #isConnecting = false
  #hadConnected = false
  /** True after giving up until a recovery attempt succeeds. */
  #hasGivenUp = false
  #lastEventAt: number | null = null
  /** Completes a pending {@link #connect} handshake wait when stop interrupts it. */
  #handshakeSettle: (() => void) | null = null
  /**
   * Bumped on every cutover / {@link stop} so a superseded socket's open/close
   * handlers cannot schedule another reconnect or refresh.
   */
  #connectGeneration = 0
  /**
   * Why the next successful open after the first should be logged the way it is.
   * Proactive token refresh is routine; unexpected drops are what operators care about.
   */
  #connectReason: 'initial' | 'refresh' | 'drop' = 'initial'

  constructor(options: EventStreamOptions) {
    this.#log = options.log
    this.#requestToken = options.requestToken
    this.#onDeviceEvent = options.onDeviceEvent
    this.#onUnavailable = options.onUnavailable
    this.#onReconnect = options.onReconnect
    this.#onRecovered = options.onRecovered
  }

  /** Whether a socket is currently open. */
  get isConnected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN
  }

  /** In-memory status for diagnostics; never touches the network. */
  getStatus(): EventStreamStatus {
    const isConnected = this.isConnected
    return {
      isConnected,
      isConnecting: this.#isConnecting && !isConnected,
      isClosed: this.#isStopped || this.#socket?.readyState === WebSocket.CLOSED,
      lastEventAgeSec: this.#lastEventAt === null
        ? null
        : Math.round((Date.now() - this.#lastEventAt) / 1000),
    }
  }

  /** Open the stream and keep it open until {@link stop} is called. */
  async start(): Promise<void> {
    this.#isStopped = false
    this.#hasGivenUp = false
    this.#connectReason = 'initial'
    // Idempotent: a second start must not leave a prior reconnect/refresh timer armed.
    this.#clearTimers()
    await this.#connect()
  }

  /** Close the stream and cancel all timers. */
  stop(): void {
    this.#isStopped = true
    this.#connectGeneration++
    this.#isConnecting = false
    this.#clearTimers()
    this.#settleHandshake()
    this.#disposeSocket()
  }

  #settleHandshake(): void {
    const settle = this.#handshakeSettle
    this.#handshakeSettle = null
    settle?.()
  }

  #clearTimers(): void {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    if (this.#refreshTimer) {
      clearTimeout(this.#refreshTimer)
      this.#refreshTimer = null
    }
    if (this.#recoveryTimer) {
      clearTimeout(this.#recoveryTimer)
      this.#recoveryTimer = null
    }
  }

  /**
   * Decide which host the stream token may be sent to.
   *
   * The endpoint arrives inside a JSON response, and the token is appended to
   * it as a query parameter. Using it unchecked means whoever controls that one
   * field controls where a live credential for a home security system is sent,
   * and a `ws://` value would additionally send it in clear text. Neither is
   * acceptable for a value this sensitive, so an endpoint that is not TLS on an
   * Alarm.com host is refused in favour of the known-good default.
   */
  #resolveEndpoint(endpoint: string | undefined): string {
    if (!endpoint) {
      return DEFAULT_WEBSOCKET_ENDPOINT
    }

    try {
      const { protocol, hostname } = new URL(endpoint)
      const isAlarmComHost = hostname === WEBSOCKET_HOST_SUFFIX.slice(1)
        || hostname.endsWith(WEBSOCKET_HOST_SUFFIX)

      if (protocol === 'wss:' && isAlarmComHost) {
        return endpoint
      }

      this.#log.warn(
        `Ignoring an event stream endpoint Alarm.com reported as ${protocol}//${hostname}, `
          + 'which is not a secure alarm.com address. Using the default instead.',
      )
    } catch {
      this.#log.warn('Ignoring an unparseable event stream endpoint. Using the default instead.')
    }

    return DEFAULT_WEBSOCKET_ENDPOINT
  }

  async #connect(): Promise<void> {
    if (this.#isStopped) {
      return
    }

    // On proactive refresh, keep the live socket until a new token is in hand.
    // Disposing first opened a silent push outage for the whole token/login path
    // (which can wait on the auth floor for minutes).
    const deferDispose = this.#connectReason === 'refresh' && this.isConnected
    const generationBeforeFetch = this.#connectGeneration

    if (!deferDispose) {
      this.#connectGeneration++
      this.#disposeSocket()
    }
    this.#settleHandshake()
    this.#isConnecting = true

    /** Whether another connect/stop superseded this attempt during the token fetch. */
    const isSuperseded = (): boolean => (
      deferDispose
        ? generationBeforeFetch !== this.#connectGeneration
        : generationBeforeFetch + 1 !== this.#connectGeneration
    )

    try {
      const { token, endpoint } = await this.#requestToken()
      if (this.#isStopped) {
        if (!isSuperseded()) {
          this.#isConnecting = false
        }
        return
      }

      if (isSuperseded()) {
        // A concurrent connect (usually the drop path) owns the socket now.
        return
      }

      if (deferDispose) {
        // A drop during the token fetch owns recovery; abandon this cutover.
        if (this.#reconnectTimer || !this.isConnected) {
          this.#isConnecting = false
          return
        }
      }

      // Cut over: invalidate any prior socket handlers, then open the new one.
      const generation = deferDispose ? ++this.#connectGeneration : this.#connectGeneration
      this.#disposeSocket()

      const target = this.#resolveEndpoint(endpoint)

      // The token must be appended raw. It is not an opaque value: it arrives
      // already percent-escaped and containing structural `&` and `=`, so it
      // expands into several query parameters rather than one. Encoding it
      // turns those separators into literals and the upgrade is refused with
      // HTTP 401. Verified against a live account with both this client and
      // Node's built-in one.
      const url = `${target}?auth=${token}`

      this.#log.debug(`connecting to the event stream at ${target}`)

      const socket = new WebSocket(url)
      this.#socket = socket

      // Wait for the first open or close so callers (startup) can finish their
      // "connected" / failure log before announcing Ready. Reconnects use the
      // same path; the await just holds the reconnect timer callback.
      await new Promise<void>((resolve) => {
        let settled = false
        const settle = (): void => {
          if (settled) {
            return
          }
          settled = true
          clearTimeout(handshakeTimer)
          this.#handshakeSettle = null
          resolve()
        }
        this.#handshakeSettle = settle

        const isCurrent = (): boolean => generation === this.#connectGeneration

        // Do not block platform Ready forever if Alarm.com never completes the
        // upgrade. Abandon the hung socket, surface a WARN, and reconnect.
        const handshakeTimer = setTimeout(() => {
          if (!isCurrent()) {
            settle()
            return
          }
          this.#isConnecting = false
          this.#recordFailureReason(
            `handshake timed out after ${WEBSOCKET_HANDSHAKE_TIMEOUT_MS}ms`,
          )
          this.#disposeSocket()
          settle()
          if (!this.#isStopped) {
            this.#scheduleReconnect()
          }
        }, WEBSOCKET_HANDSHAKE_TIMEOUT_MS)

        socket.on('open', () => {
          if (!isCurrent()) {
            settle()
            return
          }
          this.#handleOpen()
          settle()
        })
        socket.on('message', (data) => {
          if (isCurrent()) {
            this.#handleMessage(data)
          }
        })
        socket.on('error', (error) => {
          if (isCurrent()) {
            this.#recordFailureReason(error.message)
          }
        })
        socket.on('close', (code) => {
          if (isCurrent()) {
            this.#handleClose(code)
          }
          settle()
        })

        // Emitted when the HTTP upgrade is rejected. The status code is the one
        // piece of information that distinguishes a bad token from a blocked
        // client, and it is not available anywhere else.
        socket.on('unexpected-response', (_request, response) => {
          if (isCurrent()) {
            this.#recordFailureReason(
              `the server refused the connection upgrade with HTTP ${response.statusCode}`,
            )
          }
        })
      })
    } catch (error) {
      if (this.#isStopped || isSuperseded()) {
        return
      }

      // Drop already owns recovery. Do not WARN about the abandoned refresh
      // token fetch — that would set #hasReportedFailure and mask the next
      // real connect failure reason.
      if (deferDispose && (this.#reconnectTimer || !this.isConnected)) {
        this.#isConnecting = false
        this.#log.debug(`abandoned refresh token fetch after drop: ${String(error)}`)
        return
      }

      this.#isConnecting = false

      // Refresh failed but the old socket is still healthy — keep it and retry
      // the cutover soon. Log at debug only; a WARN would set #hasReportedFailure
      // and mask a later real outage reason while push updates are still flowing.
      if (deferDispose && this.isConnected) {
        this.#log.debug(
          `refresh token fetch failed; keeping the live socket: ${String(error)}`,
        )
        this.#scheduleRefreshRetry()
        return
      }

      this.#recordFailureReason(`could not obtain a stream token: ${String(error)}`)
      this.#scheduleReconnect()
    }
  }

  /** Close the current socket without scheduling a drop-reconnect. */
  #disposeSocket(): void {
    if (!this.#socket) {
      return
    }
    this.#socket.removeAllListeners()
    this.#socket.close()
    this.#socket = null
  }

  /**
   * Report why the stream failed.
   *
   * The first reason is surfaced at warn level and the rest at debug. Logging
   * every attempt loudly would be noise, but logging none of them loudly means
   * a user sees the stream give up with no indication of why, which is a
   * genuinely unhelpful place to leave someone.
   */
  #recordFailureReason(reason: string): void {
    if (this.#hasReportedFailure) {
      this.#log.debug(`event stream: ${reason}`)
      return
    }

    this.#hasReportedFailure = true
    this.#log.warn(`Alarm.com event stream could not connect: ${reason}`)
  }

  #handleOpen(): void {
    this.#isConnecting = false
    this.#consecutiveFailures = 0
    this.#hasReportedFailure = false

    const reason = this.#connectReason
    this.#connectReason = 'drop'
    const wasGivenUp = this.#hasGivenUp
    this.#hasGivenUp = false

    if (this.#hadConnected) {
      if (reason === 'refresh') {
        // Scheduled token refresh — routine, not an outage.
        this.#log.debug('Alarm.com event stream refreshed')
      } else {
        this.#log.info('Alarm.com event stream reconnected')
        this.#onReconnect?.()
      }
    } else {
      this.#log.info('Alarm.com event stream connected')
    }
    this.#hadConnected = true

    if (wasGivenUp) {
      this.#log.info('Alarm.com event stream recovered; push updates resumed')
      this.#onRecovered?.()
    }

    this.#scheduleRefresh()
  }

  /**
   * Proactively reconnect before the token expires.
   *
   * Must run *before* Alarm.com drops the socket (~5 minutes). Refreshing at or
   * after that mark races the server close; the drop path wins and logs
   * info-level "reconnected" every cycle. Jitter subtracts from the interval so
   * refresh always lands early. Multiple instances still desynchronize.
   */
  #scheduleRefresh(): void {
    if (this.#refreshTimer) {
      clearTimeout(this.#refreshTimer)
    }

    const jitter = Math.random() * WEBSOCKET_REFRESH_JITTER_MS
    const delayMs = Math.max(
      WEBSOCKET_RECONNECT_BASE_MS,
      WEBSOCKET_REFRESH_INTERVAL_MS - jitter,
    )
    this.#refreshTimer = setTimeout(() => {
      this.#log.debug('refreshing the event stream connection')
      this.#reconnect('refresh')
    }, delayMs)
  }

  /** Retry a failed refresh cutover without disposing the live socket. */
  #scheduleRefreshRetry(): void {
    if (this.#isStopped || this.#reconnectTimer) {
      return
    }

    this.#log.debug(
      `retrying event stream refresh in ${Math.round(WEBSOCKET_RECONNECT_BASE_MS / 1000)}s; keeping the live socket`,
    )
    this.#connectReason = 'refresh'
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      this.#reconnect('refresh')
    }, WEBSOCKET_RECONNECT_BASE_MS)
  }

  #handleClose(code: number): void {
    if (this.#isStopped) {
      return
    }
    this.#isConnecting = false
    this.#log.debug(`event stream closed with code ${code}`)
    // Drop path owns the next connect. Cancel a pending proactive refresh or
    // refresh-retry so neither can race the backoff into a second socket.
    if (this.#refreshTimer) {
      clearTimeout(this.#refreshTimer)
      this.#refreshTimer = null
    }
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    this.#connectReason = 'drop'
    this.#scheduleReconnect()
  }

  #reconnect(reason: 'refresh' | 'drop' = 'drop'): void {
    // Cancel a pending drop-reconnect so a refresh cannot race it into a
    // second concurrent #connect (two live sockets, doubled refresh cadence).
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    this.#connectReason = reason
    void this.#connect()
  }

  #scheduleReconnect(): void {
    if (this.#isStopped || this.#reconnectTimer || this.#recoveryTimer) {
      return
    }

    this.#consecutiveFailures++

    if (this.#consecutiveFailures > WEBSOCKET_MAX_FAILURES) {
      this.#hasGivenUp = true
      this.#log.warn(
        `The Alarm.com event stream failed ${this.#consecutiveFailures} times; `
          + `falling back to polling. Will retry in ${Math.round(WEBSOCKET_RECOVERY_INTERVAL_MS / 60_000)} minutes.`,
      )
      this.#onUnavailable()
      this.#scheduleRecovery()
      return
    }

    const delayMs = computeBackoffMs(
      this.#consecutiveFailures,
      WEBSOCKET_RECONNECT_BASE_MS,
      WEBSOCKET_RECONNECT_MAX_MS,
    )

    this.#log.debug(`reconnecting to the event stream in ${Math.round(delayMs / 1000)}s`)

    // Failure reconnects are outages, not proactive refreshes — even when the
    // attempt that failed began as a refresh cutover.
    this.#connectReason = 'drop'
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      void this.#connect()
    }, delayMs)
  }

  /** After give-up, periodically try to restore push updates. */
  #scheduleRecovery(): void {
    if (this.#isStopped || this.#recoveryTimer) {
      return
    }

    this.#recoveryTimer = setTimeout(() => {
      this.#recoveryTimer = null
      if (this.#isStopped) {
        return
      }
      this.#log.info('Retrying the Alarm.com event stream after a prior give-up')
      this.#consecutiveFailures = 0
      this.#hasReportedFailure = false
      this.#connectReason = 'drop'
      void this.#connect()
    }, WEBSOCKET_RECOVERY_INTERVAL_MS)
  }

  #handleMessage(data: WebSocket.RawData): void {
    let event: AlarmComEvent

    try {
      event = JSON.parse(data.toString()) as AlarmComEvent
    } catch {
      this.#log.debug('discarding an unparseable event stream frame')
      return
    }

    if (typeof event?.UnitId !== 'number' || typeof event?.DeviceId !== 'number') {
      return
    }

    if (event.EventType === EVENT_TYPE_USER_LOGGED_IN) {
      return
    }

    // Device resource IDs are the unit and device numbers joined by a hyphen,
    // e.g. unit 1234 device 17 is sensor "1234-17".
    const deviceResourceId = `${event.UnitId}-${event.DeviceId}`

    this.#lastEventAt = Date.now()

    this.#log.debug(
      `event type ${event.EventType} for device ${deviceResourceId}`,
    )

    this.#onDeviceEvent(deviceResourceId, event)
  }
}
