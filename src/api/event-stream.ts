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
  WEBSOCKET_HOST_SUFFIX,
  WEBSOCKET_MAX_FAILURES,
  WEBSOCKET_RECONNECT_BASE_MS,
  WEBSOCKET_RECONNECT_MAX_MS,
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
}

/** Maintains a live connection to the Alarm.com event stream. */
export class EventStream {
  readonly #log: Logger
  readonly #requestToken: () => Promise<EventStreamToken>
  readonly #onDeviceEvent: (deviceResourceId: string, event: AlarmComEvent) => void
  readonly #onUnavailable: () => void

  #socket: WebSocket | null = null
  #reconnectTimer: NodeJS.Timeout | null = null
  #refreshTimer: NodeJS.Timeout | null = null
  #consecutiveFailures = 0
  #isStopped = false
  /** Whether a failure reason has already been surfaced at warn level. */
  #hasReportedFailure = false

  constructor(options: EventStreamOptions) {
    this.#log = options.log
    this.#requestToken = options.requestToken
    this.#onDeviceEvent = options.onDeviceEvent
    this.#onUnavailable = options.onUnavailable
  }

  /** Whether a socket is currently open. */
  get isConnected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN
  }

  /** Open the stream and keep it open until {@link stop} is called. */
  async start(): Promise<void> {
    this.#isStopped = false
    await this.#connect()
  }

  /** Close the stream and cancel all timers. */
  stop(): void {
    this.#isStopped = true
    this.#clearTimers()

    if (this.#socket) {
      // Remove listeners first so the close does not schedule a reconnect.
      this.#socket.removeAllListeners()
      this.#socket.close()
      this.#socket = null
    }
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

    try {
      const { token, endpoint } = await this.#requestToken()
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

      socket.on('open', () => this.#handleOpen())
      socket.on('message', (data) => this.#handleMessage(data))
      socket.on('error', (error) => this.#recordFailureReason(error.message))
      socket.on('close', (code) => this.#handleClose(code))

      // Emitted when the HTTP upgrade is rejected. The status code is the one
      // piece of information that distinguishes a bad token from a blocked
      // client, and it is not available anywhere else.
      socket.on('unexpected-response', (_request, response) => {
        this.#recordFailureReason(
          `the server refused the connection upgrade with HTTP ${response.statusCode}`,
        )
      })
    } catch (error) {
      this.#recordFailureReason(`could not obtain a stream token: ${String(error)}`)
      this.#scheduleReconnect()
    }
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
    this.#consecutiveFailures = 0
    this.#hasReportedFailure = false
    this.#log.debug('event stream connected')
    this.#scheduleRefresh()
  }

  /**
   * Proactively reconnect before the token expires.
   *
   * A silently dead socket is worse than a briefly interrupted one: HomeKit
   * would keep showing stale state with nothing logged anywhere. Jitter keeps
   * multiple Homebridge instances from reconnecting in unison.
   */
  #scheduleRefresh(): void {
    if (this.#refreshTimer) {
      clearTimeout(this.#refreshTimer)
    }

    const jitter = Math.random() * WEBSOCKET_REFRESH_JITTER_MS
    this.#refreshTimer = setTimeout(() => {
      this.#log.debug('refreshing the event stream connection')
      this.#reconnect()
    }, WEBSOCKET_REFRESH_INTERVAL_MS + jitter)
  }

  #handleClose(code: number): void {
    if (this.#isStopped) {
      return
    }
    this.#log.debug(`event stream closed with code ${code}`)
    this.#scheduleReconnect()
  }

  #reconnect(): void {
    if (this.#socket) {
      this.#socket.removeAllListeners()
      this.#socket.close()
      this.#socket = null
    }
    void this.#connect()
  }

  #scheduleReconnect(): void {
    if (this.#isStopped || this.#reconnectTimer) {
      return
    }

    this.#consecutiveFailures++

    if (this.#consecutiveFailures > WEBSOCKET_MAX_FAILURES) {
      this.#log.warn(
        `The Alarm.com event stream failed ${this.#consecutiveFailures} times; falling back to polling for state updates.`,
      )
      this.#onUnavailable()
      return
    }

    const delayMs = computeBackoffMs(
      this.#consecutiveFailures,
      WEBSOCKET_RECONNECT_BASE_MS,
      WEBSOCKET_RECONNECT_MAX_MS,
    )

    this.#log.debug(`reconnecting to the event stream in ${Math.round(delayMs / 1000)}s`)

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      void this.#connect()
    }, delayMs)
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

    this.#log.debug(
      `event type ${event.EventType} for device ${deviceResourceId}`,
    )

    this.#onDeviceEvent(deviceResourceId, event)
  }
}
