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
  ALARM_COM_APEX_HOST,
  DEFAULT_WEBSOCKET_ENDPOINT,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  WEBSOCKET_HANDSHAKE_TIMEOUT_MS,
  WEBSOCKET_HOST_SUFFIX,
  WEBSOCKET_MAX_FAILURES,
  WEBSOCKET_RECONNECT_BASE_MS,
  WEBSOCKET_RECONNECT_MAX_MS,
  WEBSOCKET_RECOVERY_INTERVAL_MS,
  WEBSOCKET_REFRESH_INTERVAL_MS,
  WEBSOCKET_REFRESH_JITTER_MS,
} from '../settings'
import type { EventStreamToken } from '../types/alarm'
import { EVENT_TYPE_USER_LOGGED_IN, type AlarmComEvent } from '../types/events'
import type { Logger } from '../utils/logger'
import { computeBackoffMs } from '../utils/retry'
import { sanitizeError } from '../utils/sanitizers'

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
  /**
   * Seconds since the live socket was lost.
   *
   * `null` while connected, or before the stream has ever connected. Health
   * uses this — not {@link lastEventAgeSec} — so a quiet house does not look
   * like an outage the moment the socket blips.
   */
  disconnectAgeSec: number | null
}

/**
 * One in-flight {@link EventStream.connect} attempt.
 *
 * Carried explicitly rather than as loose locals so the token fetch, the
 * socket cutover, and the error taxonomy can each be read on their own and
 * still agree about whether this attempt still owns the connection.
 */
interface ConnectAttempt {
  /**
   * True when a live socket is kept through token fetch *and* the candidate
   * handshake (make-before-break refresh).
   */
  readonly shouldDeferDispose: boolean
  /** Whether another connect or a stop took ownership during the token fetch. */
  readonly isSuperseded: () => boolean
}

/** Predicates shared by the handshake listeners for one open attempt. */
interface HandshakeContext {
  readonly isRefreshCandidate: boolean
  readonly isCurrentGeneration: () => boolean
  readonly isLiveSocket: () => boolean
  readonly isCandidateSocket: () => boolean
}

/** Maintains a live connection to the Alarm.com event stream. */
export class EventStream {
  readonly #log: Logger
  readonly #requestToken: () => Promise<EventStreamToken>
  readonly #onDeviceEvent: (deviceResourceId: string, event: AlarmComEvent) => void
  readonly #onUnavailable: () => void
  readonly #onReconnect: (() => void) | undefined
  readonly #onRecovered: (() => void) | undefined

  /** The socket currently carrying push traffic. */
  #socket: WebSocket | null = null
  /**
   * In-flight refresh handshake. Kept separate from {@link #socket} so a
   * timed-out cutover can be abandoned without killing the live connection.
   */
  #candidate: WebSocket | null = null
  #reconnectTimer: NodeJS.Timeout | null = null
  #refreshTimer: NodeJS.Timeout | null = null
  #recoveryTimer: NodeJS.Timeout | null = null
  #consecutiveFailures = 0
  #isStopped = false
  #isConnecting = false
  #hadConnected = false
  /** True after giving up until a recovery attempt succeeds. */
  #hasGivenUp = false
  /**
   * Give-up cycles since the last successful connection.
   *
   * Each recovery cycle resets the failure counters, so without this a
   * prolonged Alarm.com outage re-emitted the whole "gave up, falling back to
   * polling" warning set every recovery interval, forever.
   */
  #giveUpCount = 0
  #lastEventAt: number | null = null
  /** When the live socket was lost; cleared on the next successful open. */
  #disconnectedAt: number | null = null
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
        : Math.round((Date.now() - this.#lastEventAt) / MS_PER_SECOND),
      disconnectAgeSec: isConnected || this.#disconnectedAt === null
        ? null
        : Math.round((Date.now() - this.#disconnectedAt) / MS_PER_SECOND),
    }
  }

  /** Open the stream and keep it open until {@link stop} is called. */
  async start(): Promise<void> {
    this.#isStopped = false
    this.#hasGivenUp = false
    this.#giveUpCount = 0
    // Reset with the rest, or a restart after a give-up would abandon the stream
    // on its first attempt using counters from the previous run.
    this.#consecutiveFailures = 0
    this.#hadConnected = false
    this.#disconnectedAt = null
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
    this.#disposeCandidate()
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
      const isAlarmComHost = hostname === ALARM_COM_APEX_HOST
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

    const attempt = this.#beginAttempt()

    try {
      const token = await this.#requestToken()
      if (!this.#stillOwnsConnection(attempt)) {
        return
      }
      await this.#openSocket(attempt, token)
    } catch (error) {
      this.#handleConnectFailure(attempt, error)
    }
  }

  /**
   * Claim ownership of the next connection and describe the attempt.
   *
   * On proactive refresh the live socket is kept through token fetch *and* the
   * candidate handshake (make-before-break). Disposing first opened a silent
   * push outage for the whole token/login path, and a hung upgrade turned a
   * routine refresh into a real outage plus a noisy WARN/INFO pair.
   */
  #beginAttempt(): ConnectAttempt {
    const shouldDeferDispose = this.#connectReason === 'refresh' && this.isConnected
    const generationBeforeFetch = this.#connectGeneration

    if (!shouldDeferDispose) {
      this.#connectGeneration++
      this.#disposeCandidate()
      this.#disposeSocket()
    }
    this.#settleHandshake()
    this.#isConnecting = true

    return {
      shouldDeferDispose,
      isSuperseded: () => (
        shouldDeferDispose
          ? generationBeforeFetch !== this.#connectGeneration
          : generationBeforeFetch + 1 !== this.#connectGeneration
      ),
    }
  }

  /** Whether this attempt should still cut a socket over after its token fetch. */
  #stillOwnsConnection(attempt: ConnectAttempt): boolean {
    if (this.#isStopped) {
      if (!attempt.isSuperseded()) {
        this.#isConnecting = false
      }
      return false
    }

    if (attempt.isSuperseded()) {
      // A concurrent connect (usually the drop path) owns the socket now.
      return false
    }

    if (attempt.shouldDeferDispose && (this.#reconnectTimer || !this.isConnected)) {
      // A drop during the token fetch owns recovery; abandon this cutover.
      this.#isConnecting = false
      return false
    }

    return true
  }

  /** Open a socket and wait for its handshake to settle. */
  async #openSocket(attempt: ConnectAttempt, { token, endpoint }: EventStreamToken): Promise<void> {
    const target = this.#resolveEndpoint(endpoint)

    // The token must be appended raw. It is not an opaque value: it arrives
    // already percent-escaped and containing structural `&` and `=`, so it
    // expands into several query parameters rather than one. Encoding it
    // turns those separators into literals and the upgrade is refused with
    // HTTP 401. Verified against a live account with both this client and
    // Node's built-in one.
    const url = `${target}?auth=${token}`

    this.#log.debug(`connecting to the event stream at ${target}`)

    if (attempt.shouldDeferDispose && this.isConnected) {
      // Make-before-break: open a candidate beside the live socket. Bump
      // generation so a superseded refresh cannot promote a stale candidate,
      // but keep the live socket's handlers keyed on socket identity so push
      // frames keep flowing during the handshake.
      this.#connectGeneration++
      this.#disposeCandidate()
      const candidate = new WebSocket(url)
      this.#candidate = candidate
      await this.#awaitHandshake(candidate, {
        generation: this.#connectGeneration,
        isRefreshCandidate: true,
      })
      return
    }

    this.#disposeCandidate()
    this.#disposeSocket()
    const socket = new WebSocket(url)
    this.#socket = socket
    await this.#awaitHandshake(socket, {
      generation: this.#connectGeneration,
      isRefreshCandidate: false,
    })
  }

  /**
   * Wait for the first open or close on a freshly opened socket.
   *
   * Callers at startup need their "connected" or failure line to land before
   * Ready is announced. Reconnects take the same path; there the await merely
   * holds the reconnect timer's callback.
   */
  #awaitHandshake(
    socket: WebSocket,
    options: { generation: number, isRefreshCandidate: boolean },
  ): Promise<void> {
    const { generation, isRefreshCandidate } = options

    return new Promise<void>((resolve) => {
      let isSettled = false
      const handshake = { timer: null as NodeJS.Timeout | null }
      const settle = (): void => {
        if (isSettled) {
          return
        }
        isSettled = true
        if (handshake.timer) {
          clearTimeout(handshake.timer)
        }
        this.#handshakeSettle = null
        resolve()
      }
      this.#handshakeSettle = settle

      const ctx: HandshakeContext = {
        isRefreshCandidate,
        isCurrentGeneration: () => generation === this.#connectGeneration,
        isLiveSocket: () => this.#socket === socket,
        isCandidateSocket: () => this.#candidate === socket,
      }

      // Do not block platform Ready forever if Alarm.com never completes the
      // upgrade. A hung *refresh* candidate is abandoned quietly; a hung
      // drop/initial socket is an outage and reconnects loudly.
      handshake.timer = setTimeout(() => {
        this.#onHandshakeTimeout(ctx, settle)
      }, WEBSOCKET_HANDSHAKE_TIMEOUT_MS)

      socket.on('open', () => {
        this.#onHandshakeOpen(socket, ctx, settle)
      })
      socket.on('message', (data) => {
        // Live socket identity, not generation: during make-before-break the
        // candidate bumps generation while the live socket must keep delivering.
        if (ctx.isLiveSocket()) {
          this.#handleMessage(data)
        }
      })
      socket.on('error', (error) => {
        this.#onHandshakeTransportFailure(ctx, error.message)
      })
      socket.on('close', (code) => {
        this.#onHandshakeClose(ctx, code, settle)
      })
      // Emitted when the HTTP upgrade is rejected. The status code is the one
      // piece of information that distinguishes a bad token from a blocked
      // client, and it is not available anywhere else.
      socket.on('unexpected-response', (_request, response) => {
        this.#onHandshakeTransportFailure(
          ctx,
          `the server refused the connection upgrade with HTTP ${response.statusCode}`,
        )
      })
    })
  }

  #onHandshakeTimeout(ctx: HandshakeContext, settle: () => void): void {
    if (!ctx.isCurrentGeneration()) {
      settle()
      return
    }
    this.#isConnecting = false
    if (ctx.isRefreshCandidate && ctx.isCandidateSocket() && this.isConnected) {
      this.#log.debug(
        `refresh handshake timed out after ${WEBSOCKET_HANDSHAKE_TIMEOUT_MS}ms; `
          + 'keeping the live socket',
      )
      this.#disposeCandidate()
      settle()
      if (!this.#isStopped) {
        this.#scheduleRefreshRetry()
      }
      return
    }
    if (!ctx.isLiveSocket() && !ctx.isCandidateSocket()) {
      settle()
      return
    }
    this.#recordFailureReason(
      `handshake timed out after ${WEBSOCKET_HANDSHAKE_TIMEOUT_MS}ms`,
    )
    this.#disposeCandidate()
    this.#disposeSocket()
    settle()
    if (!this.#isStopped) {
      this.#scheduleReconnect()
    }
  }

  #onHandshakeOpen(socket: WebSocket, ctx: HandshakeContext, settle: () => void): void {
    if (!ctx.isCurrentGeneration()) {
      settle()
      return
    }
    if (ctx.isRefreshCandidate) {
      if (!ctx.isCandidateSocket()) {
        settle()
        return
      }
      // Promote the candidate; only now tear down the previous live socket.
      const previous = this.#socket
      this.#candidate = null
      this.#socket = socket
      this.#closeSocket(previous)
      this.#handleOpen()
      settle()
      return
    }
    if (!ctx.isLiveSocket()) {
      settle()
      return
    }
    this.#handleOpen()
    settle()
  }

  #onHandshakeClose(ctx: HandshakeContext, code: number, settle: () => void): void {
    if (ctx.isRefreshCandidate && ctx.isCandidateSocket()) {
      this.#candidate = null
      this.#isConnecting = false
      if (this.isConnected && !this.#isStopped) {
        this.#log.debug(
          `refresh candidate closed with code ${code}; keeping the live socket`,
        )
        this.#scheduleRefreshRetry()
      } else if (!this.#isStopped && !this.isConnected) {
        // Live died during the cutover — drop path owns recovery.
        this.#handleClose(code)
      }
      settle()
      return
    }
    // Live close is keyed on socket identity, not generation: a refresh
    // candidate bumps generation while the live socket must still recover.
    if (ctx.isLiveSocket()) {
      this.#disposeCandidate()
      if (!this.#isStopped) {
        this.#handleClose(code)
      }
    }
    settle()
  }

  /** Surface a transport failure, or swallow it when a refresh candidate fails quietly. */
  #onHandshakeTransportFailure(ctx: HandshakeContext, reason: string): void {
    if (!ctx.isCurrentGeneration()) {
      return
    }
    if (ctx.isRefreshCandidate && ctx.isCandidateSocket() && this.isConnected) {
      this.#log.debug(`refresh ${reason}; keeping the live socket`)
      return
    }
    if (ctx.isLiveSocket() || ctx.isCandidateSocket()) {
      this.#recordFailureReason(reason)
    }
  }

  /**
   * Decide what a failed connect attempt means.
   *
   * Four outcomes, and telling them apart is the whole job: the stream was
   * stopped, another attempt took over, a refresh failed while the old socket
   * is still carrying traffic, or push updates are genuinely down.
   */
  #handleConnectFailure(attempt: ConnectAttempt, error: unknown): void {
    if (this.#isStopped || attempt.isSuperseded()) {
      return
    }

    // Drop already owns recovery. Do not WARN about the abandoned refresh
    // token fetch — that would set #hasReportedFailure and mask the next
    // real connect failure reason.
    if (attempt.shouldDeferDispose && (this.#reconnectTimer || !this.isConnected)) {
      this.#isConnecting = false
      this.#log.debug(`abandoned refresh token fetch after drop: ${sanitizeError(error)}`)
      return
    }

    this.#isConnecting = false

    // Refresh failed but the old socket is still healthy — keep it and retry
    // the cutover soon. Log at debug only; a WARN would set #hasReportedFailure
    // and mask a later real outage reason while push updates are still flowing.
    if (attempt.shouldDeferDispose && this.isConnected) {
      this.#log.debug(
        `refresh token fetch failed; keeping the live socket: ${sanitizeError(error)}`,
      )
      this.#scheduleRefreshRetry()
      return
    }

    this.#recordFailureReason(`could not obtain a stream token: ${sanitizeError(error)}`)
    this.#scheduleReconnect()
  }

  /**
   * Close a socket without scheduling a drop-reconnect.
   *
   * Must tolerate every readyState. Aborting a CONNECTING handshake makes `ws`
   * emit `'error'` (via `abortHandshake` / `nextTick`); after
   * `removeAllListeners()` that becomes an uncaught exception and kills the
   * child bridge. Keep a no-op listener through `close()`.
   */
  #closeSocket(socket: WebSocket | null): void {
    if (!socket) {
      return
    }
    socket.removeAllListeners()
    socket.on('error', () => {})
    if (socket.readyState !== WebSocket.CLOSED) {
      socket.close()
    }
  }

  /** Drop the live socket and record the disconnect for health. */
  #disposeSocket(): void {
    if (!this.#socket) {
      return
    }
    const wasOpen = this.#socket.readyState === WebSocket.OPEN
    const socket = this.#socket
    this.#socket = null
    if (wasOpen || this.#hadConnected) {
      this.#noteDisconnect()
    }
    this.#closeSocket(socket)
  }

  /** Drop an abandoned refresh candidate without touching the live socket. */
  #disposeCandidate(): void {
    if (!this.#candidate) {
      return
    }
    const socket = this.#candidate
    this.#candidate = null
    this.#closeSocket(socket)
  }

  #noteDisconnect(): void {
    if (this.#disconnectedAt === null) {
      this.#disconnectedAt = Date.now()
    }
  }

  /**
   * Record why the stream failed (always at debug).
   *
   * Token fetch shares the API client and circuit breaker, so a warn here
   * restates an outage the breaker line already announced — often twice in a
   * row (timeout, then "Circuit breaker is open"). Socket/handshake detail stays
   * under debug; give-up is the single default-visible stream outage line.
   */
  #recordFailureReason(reason: string): void {
    this.#log.debug(`event stream: ${reason}`)
  }

  /**
   * Run a caller-supplied callback without letting it reach the event loop.
   *
   * These fire inside `ws` listeners, where an uncaught exception is not a
   * logged error but a dead child bridge — the same failure mode
   * {@link #disposeSocket} already guards against on the error channel.
   */
  #notify(name: string | (() => string), callback: (() => void) | undefined): void {
    try {
      callback?.()
    } catch (error) {
      const label = typeof name === 'string' ? name : name()
      this.#log.warn(`event stream ${label} handler failed: ${sanitizeError(error)}`)
    }
  }

  #handleOpen(): void {
    this.#isConnecting = false
    this.#consecutiveFailures = 0
    this.#giveUpCount = 0
    this.#disconnectedAt = null

    const reason = this.#connectReason
    this.#connectReason = 'drop'
    const wasGivenUp = this.#hasGivenUp
    this.#hasGivenUp = false

    if (this.#hadConnected) {
      if (reason === 'refresh') {
        // Scheduled token refresh — routine, not an outage.
        this.#log.debug('Alarm.com event stream refreshed')
      } else {
        // Mid-session drop recovery is debug. A brief blip that never reached
        // give-up must not pair a quiet failure with an info "reconnected".
        // Give-up recovery has its own info line below.
        this.#log.debug('Alarm.com event stream reconnected')
        this.#notify('reconnect', this.#onReconnect)
      }
    } else {
      this.#log.info('Alarm.com event stream connected')
    }
    this.#hadConnected = true

    if (wasGivenUp) {
      this.#log.info('Alarm.com event stream recovered; push updates resumed')
      this.#notify('recovered', this.#onRecovered)
    }

    this.#scheduleRefresh()
  }

  /**
   * Proactively reconnect before the token expires.
   *
   * Must run *before* Alarm.com drops the socket (~5 minutes). Refreshing at or
   * after that mark races the server close; the drop path wins and would log a
   * reconnect every cycle. Make-before-break keeps the live socket through the
   * candidate handshake so a hung upgrade is a quiet retry rather than an
   * outage. Jitter subtracts from the interval so refresh always lands early.
   * Multiple instances still desynchronize.
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
      // Cleared like every other timer callback here. Leaving a fired handle in
      // place makes any future `if (this.#refreshTimer)` guard read a lie.
      this.#refreshTimer = null
      this.#log.debug('refreshing the event stream connection')
      this.#reconnect('refresh')
    }, delayMs)
    this.#refreshTimer.unref?.()
  }

  /** Retry a failed refresh cutover without disposing the live socket. */
  #scheduleRefreshRetry(): void {
    if (this.#isStopped || this.#reconnectTimer) {
      return
    }

    this.#log.debug(
      `retrying event stream refresh in ${Math.round(WEBSOCKET_RECONNECT_BASE_MS / MS_PER_SECOND)}s; keeping the live socket`,
    )
    this.#connectReason = 'refresh'
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      this.#reconnect('refresh')
    }, WEBSOCKET_RECONNECT_BASE_MS)
    this.#reconnectTimer.unref?.()
  }

  #handleClose(code: number): void {
    if (this.#isStopped) {
      return
    }
    this.#isConnecting = false
    this.#noteDisconnect()
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
      this.#giveUpCount++

      // Debug only: the circuit breaker (and Health, when enabled) already
      // announce the outage at default log levels. Notify the platform once per
      // give-up episode so it can lean on polling without repeating this every
      // recovery cycle.
      const summary = 'Alarm.com event stream unavailable; falling back to polling. '
        + `Will retry in ${Math.round(WEBSOCKET_RECOVERY_INTERVAL_MS / MS_PER_MINUTE)} minutes.`

      this.#log.debug(summary)
      if (this.#giveUpCount === 1) {
        this.#notify('unavailable', this.#onUnavailable)
      }

      this.#scheduleRecovery()
      return
    }

    const delayMs = computeBackoffMs(
      this.#consecutiveFailures,
      WEBSOCKET_RECONNECT_BASE_MS,
      WEBSOCKET_RECONNECT_MAX_MS,
    )

    this.#log.debug(`reconnecting to the event stream in ${Math.round(delayMs / MS_PER_SECOND)}s`)

    // Failure reconnects are outages, not proactive refreshes — even when the
    // attempt that failed began as a refresh cutover.
    this.#connectReason = 'drop'
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      void this.#connect()
    }, delayMs)
    // Unref'd: a 15-minute recovery timer is exactly what holds a child bridge
    // open and looks like a hang when shutdown does not arrive.
    this.#reconnectTimer.unref?.()
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
      const message = 'Retrying the Alarm.com event stream after a prior give-up'
      if (this.#giveUpCount <= 1) {
        this.#log.info(message)
      } else {
        this.#log.debug(message)
      }
      this.#consecutiveFailures = 0
      this.#connectReason = 'drop'
      void this.#connect()
    }, WEBSOCKET_RECOVERY_INTERVAL_MS)
    this.#recoveryTimer.unref?.()
  }

  #handleMessage(data: WebSocket.RawData): void {
    let event: AlarmComEvent

    try {
      event = JSON.parse(decodeFrame(data)) as AlarmComEvent
    } catch {
      this.#log.debug('discarding an unparseable event stream frame')
      return
    }

    if (!isUsableEvent(event)) {
      return
    }

    if (event.EventType === EVENT_TYPE_USER_LOGGED_IN) {
      return
    }

    // Device resource IDs are the unit and device numbers joined by a hyphen,
    // e.g. unit 1234 device 17 is sensor "1234-17".
    const deviceResourceId = `${event.UnitId}-${event.DeviceId}`

    this.#lastEventAt = Date.now()

    // Guarded: this runs once per pushed frame, and the template is built before
    // the call whether or not the line is ever written. `isDebugEnabled` exists
    // for exactly this, and the hottest path was the one place not using it.
    if (this.#log.isDebugEnabled) {
      this.#log.debug(`event type ${event.EventType} for device ${deviceResourceId}`)
    }

    this.#notify(
      () => `device event for ${deviceResourceId}`,
      () => this.#onDeviceEvent(deviceResourceId, event),
    )
  }
}

/**
 * Decode a WebSocket frame to text.
 *
 * `RawData` is `Buffer | ArrayBuffer | Buffer[]`, and `toString()` is only
 * correct for the first: on an `ArrayBuffer` it yields `[object ArrayBuffer]`,
 * and on a fragment array it comma-joins the pieces. The default `binaryType`
 * means the plugin sees a `Buffer` today, so this is about the two shapes the
 * type permits rather than one observed — but silently parsing
 * `[object ArrayBuffer]` is a bad way to find that out.
 */
function decodeFrame(data: WebSocket.RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8')
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8')
  }
  return data.toString('utf8')
}

/**
 * Whether a parsed frame carries the three fields the plugin actually reads.
 *
 * `AlarmComEvent` declares eight required fields on a value that came from
 * `JSON.parse`, so the type is an assertion rather than a guarantee. `EventType`
 * is checked alongside the two identifiers because it is compared numerically
 * and then drives a `switch` — a string there fell through to `undefined`, which
 * was safe by luck rather than by construction.
 */
function isUsableEvent(event: AlarmComEvent): boolean {
  return typeof event?.UnitId === 'number'
    && typeof event?.DeviceId === 'number'
    && typeof event?.EventType === 'number'
}
