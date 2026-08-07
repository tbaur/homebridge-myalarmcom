/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The `ws` module is replaced with an emitter the test drives by hand, so
 * frames, closes, and upgrade rejections can be delivered on demand without a
 * server. The stream is only ever a hint that a device changed, so the
 * assertions are about which resource id comes out, not about event payloads.
 */

import type { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { EventStream, type AlarmComEvent } from '../../../src/api/event-stream'
import {
  DEFAULT_WEBSOCKET_ENDPOINT,
  WEBSOCKET_HANDSHAKE_TIMEOUT_MS,
  WEBSOCKET_RECONNECT_BASE_MS,
  WEBSOCKET_RECONNECT_MAX_MS,
  WEBSOCKET_REFRESH_INTERVAL_MS,
} from '../../../src/settings'
import { createRecordingLogger, messagesAt, type RecordingLogger } from '../../helpers/logger'
import eventsFixture from '../../fixtures/events.json'
import { fixtureAt } from '../../helpers/fixtures'

jest.mock('ws', () => {
  const { EventEmitter: NodeEventEmitter } = jest.requireActual<typeof import('node:events')>('node:events')

  class MockWebSocket extends NodeEventEmitter {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSED = 3
    static readonly instances: MockWebSocket[] = []

    readyState = MockWebSocket.CONNECTING
    closeCount = 0

    constructor(readonly url: string) {
      super()
      MockWebSocket.instances.push(this)
    }

    close(): void {
      this.closeCount++
      // Mirror ws abortHandshake: closing while CONNECTING emits
      // 'WebSocket was closed before the connection was established'.
      // Real ws does this on nextTick; emit here synchronously so tests catch
      // a missing error sink without flushing the event loop.
      if (this.readyState === MockWebSocket.CONNECTING) {
        this.emit(
          'error',
          new Error('WebSocket was closed before the connection was established'),
        )
      }
      this.readyState = MockWebSocket.CLOSED
    }
  }

  return MockWebSocket
})

interface MockSocket extends EventEmitter {
  url: string
  readyState: number
  closeCount: number
}

const MockWebSocket = WebSocket as unknown as {
  CONNECTING: number
  OPEN: number
  CLOSED: number
  instances: MockSocket[]
}

const fixtureEvents = eventsFixture.events as AlarmComEvent[]
const signInEvent = fixtureAt(fixtureEvents, 0, 'events')
const deviceEvent = fixtureAt(fixtureEvents, 1, 'events')

describe('EventStream', () => {
  let log: RecordingLogger
  let requestToken: jest.Mock
  let onDeviceEvent: jest.Mock
  let onUnavailable: jest.Mock
  let stream: EventStream

  function createStream(): EventStream {
    return new EventStream({
      log,
      requestToken: requestToken,
      onDeviceEvent: onDeviceEvent,
      onUnavailable: onUnavailable,
    })
  }

  /** The socket the stream most recently opened. */
  function currentSocket(): MockSocket {
    const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1]
    if (!socket) {
      throw new Error('The stream never opened a socket')
    }
    return socket
  }

  /** Let `requestToken` resolve and the WebSocket constructor run. */
  async function flushConnect(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
  }

  /**
   * Start the stream and complete the first handshake.
   *
   * `start()` waits for open/close so platform startup can log Ready last;
   * tests must drive that handshake explicitly.
   */
  async function startOpen(): Promise<MockSocket> {
    const pending = stream.start()
    await flushConnect()
    const socket = currentSocket()
    socket.readyState = MockWebSocket.OPEN
    socket.emit('open')
    await pending
    return socket
  }

  /** Start far enough to create a socket, without completing the handshake. */
  async function startPending(): Promise<{ pending: Promise<void>, socket: MockSocket }> {
    const pending = stream.start()
    await flushConnect()
    return { pending, socket: currentSocket() }
  }

  /** Advance reconnect backoff and complete the next handshake. */
  async function openAfterReconnect(delayMs: number): Promise<MockSocket> {
    await jest.advanceTimersByTimeAsync(delayMs)
    await flushConnect()

    // A long advance can also expire the new connect's handshake timer, which
    // disposes that socket and arms another reconnect. Keep following until a
    // live socket is ready to open.
    for (let attempt = 0; attempt < 4; attempt++) {
      await flushConnect()
      const socket = MockWebSocket.instances.at(-1)
      if (socket && socket.closeCount === 0) {
        socket.readyState = MockWebSocket.OPEN
        socket.emit('open')
        return socket
      }
      await jest.advanceTimersByTimeAsync(WEBSOCKET_RECONNECT_BASE_MS)
    }

    throw new Error('The stream never opened a socket after reconnect')
  }

  beforeEach(() => {
    jest.useFakeTimers()
    MockWebSocket.instances.length = 0
    log = createRecordingLogger()
    requestToken = jest.fn().mockResolvedValue({ token: 'stream-token' })
    onDeviceEvent = jest.fn()
    onUnavailable = jest.fn()
    stream = createStream()
  })

  afterEach(() => {
    stream.stop()
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  describe('connecting', () => {
    it('opens the endpoint Alarm.com named, carrying the token', async () => {
      requestToken.mockResolvedValue({ token: 'stream-token', endpoint: 'wss://webskt-eu.alarm.com:8443' })

      await startOpen()

      expect(currentSocket().url).toBe('wss://webskt-eu.alarm.com:8443?auth=stream-token')
    })

    /**
     * The endpoint is server-controlled and the token is appended to it, so
     * whoever controls that field would otherwise choose where a live
     * credential for a security system is sent. Anything that is not TLS on an
     * Alarm.com host is refused in favour of the known-good default.
     */
    describe('refusing an endpoint it should not send the token to', () => {
      it.each([
        ['a foreign host', 'wss://attacker.example:8443'],
        ['plaintext websockets', 'ws://webskt.alarm.com:8443'],
        ['a lookalike domain', 'wss://webskt.alarm.com.attacker.example'],
        ['a non-websocket scheme', 'https://webskt.alarm.com'],
        ['something unparseable', 'not-a-url'],
      ])('ignores %s and uses the default instead', async (_label, endpoint) => {
        requestToken.mockResolvedValue({ token: 'stream-token', endpoint })

        await startOpen()

        expect(currentSocket().url).toBe(`${DEFAULT_WEBSOCKET_ENDPOINT}?auth=stream-token`)
        expect(messagesAt(log, 'warn').join('\n')).toMatch(/event stream endpoint/i)
      })

      it('accepts the canonical host itself, not only its subdomains', async () => {
        requestToken.mockResolvedValue({ token: 'stream-token', endpoint: 'wss://alarm.com:8443' })

        await startOpen()

        expect(currentSocket().url).toBe('wss://alarm.com:8443?auth=stream-token')
      })
    })

    it('falls back to the default endpoint when none was supplied', async () => {
      await startOpen()

      expect(currentSocket().url).toBe(`${DEFAULT_WEBSOCKET_ENDPOINT}?auth=stream-token`)
    })

    it('appends the token verbatim, since it already carries its own separators', async () => {
      requestToken.mockResolvedValue({ token: 'id%3D42&sig%3Dabc' })

      await startOpen()

      expect(currentSocket().url).toBe(`${DEFAULT_WEBSOCKET_ENDPOINT}?auth=id%3D42&sig%3Dabc`)
    })

    it('reports itself connected only once the socket is open', async () => {
      const { pending, socket } = await startPending()
      expect(stream.isConnected).toBe(false)

      socket.readyState = MockWebSocket.OPEN
      expect(stream.isConnected).toBe(true)
      socket.emit('open')
      await pending
    })

    it('logs when the stream connects and quietly when it reconnects', async () => {
      await startOpen()

      expect(messagesAt(log, 'info')).toContain('Alarm.com event stream connected')

      currentSocket().emit('close', 1006)
      await openAfterReconnect(WEBSOCKET_RECONNECT_BASE_MS)

      // A brief mid-session drop that never reaches give-up stays at debug.
      expect(messagesAt(log, 'info')).not.toContain('Alarm.com event stream reconnected')
      expect(messagesAt(log, 'debug')).toContain('Alarm.com event stream reconnected')
    })

    it('abandons a hung handshake and schedules a reconnect', async () => {
      const { pending, socket } = await startPending()
      expect(socket.readyState).toBe(MockWebSocket.CONNECTING)

      // ws emits 'error' synchronously when close() aborts a CONNECTING
      // handshake. Disposing without an error sink used to crash the process.
      await expect(
        jest.advanceTimersByTimeAsync(WEBSOCKET_HANDSHAKE_TIMEOUT_MS),
      ).resolves.toBeUndefined()
      await pending

      expect(messagesAt(log, 'debug').join('\n')).toMatch(/handshake timed out/)
      expect(messagesAt(log, 'warn').join('\n')).not.toMatch(/handshake timed out/)
      expect(socket.closeCount).toBe(1)
      expect(socket.readyState).toBe(MockWebSocket.CLOSED)
      expect(stream.isConnected).toBe(false)

      await openAfterReconnect(WEBSOCKET_RECONNECT_BASE_MS)
      expect(messagesAt(log, 'info')).toContain('Alarm.com event stream connected')
    })

    it('can replace a still-connecting socket without crashing', async () => {
      const { pending: firstHandshake, socket: firstSocket } = await startPending()
      expect(firstSocket.readyState).toBe(MockWebSocket.CONNECTING)

      // A second start() disposes the in-flight CONNECTING socket before opening
      // another — the same abortHandshake error path as a handshake timeout.
      const secondStart = stream.start()
      await flushConnect()

      expect(firstSocket.closeCount).toBe(1)
      expect(firstSocket.readyState).toBe(MockWebSocket.CLOSED)

      const secondSocket = currentSocket()
      expect(secondSocket).not.toBe(firstSocket)
      secondSocket.readyState = MockWebSocket.OPEN
      secondSocket.emit('open')
      await secondStart
      await firstHandshake

      expect(stream.isConnected).toBe(true)
    })
  })

  describe('incoming frames', () => {
    beforeEach(async () => {
      await startOpen()
    })

    it('turns a device frame into the resource id built from the unit and device', () => {
      currentSocket().emit('message', JSON.stringify(deviceEvent))

      expect(onDeviceEvent).toHaveBeenCalledTimes(1)
      expect(onDeviceEvent).toHaveBeenCalledWith('1234567-2', deviceEvent)
    })

    it('ignores a user sign-in, which carries no device state', () => {
      expect(signInEvent.EventType).toBe(55)

      currentSocket().emit('message', JSON.stringify(signInEvent))

      expect(onDeviceEvent).not.toHaveBeenCalled()
    })

    it('discards an unparseable frame without throwing', () => {
      expect(() => currentSocket().emit('message', 'not json at all {')).not.toThrow()
      expect(onDeviceEvent).not.toHaveBeenCalled()
      expect(messagesAt(log, 'debug')).toContain('discarding an unparseable event stream frame')
    })

    it('ignores a frame that names no device', () => {
      currentSocket().emit('message', JSON.stringify({ EventType: 100, UnitId: 1234567 }))
      currentSocket().emit('message', JSON.stringify({ EventType: 100, DeviceId: 2 }))
      currentSocket().emit('message', 'null')

      expect(onDeviceEvent).not.toHaveBeenCalled()
    })

    it('accepts a frame delivered as a Buffer', () => {
      currentSocket().emit('message', Buffer.from(JSON.stringify(deviceEvent)))

      expect(onDeviceEvent).toHaveBeenCalledWith('1234567-2', deviceEvent)
    })

    it('never logs the raw extra-data query string, which can carry account detail', () => {
      currentSocket().emit('message', JSON.stringify({
        ...deviceEvent,
        QstringForExtraData: 'accountEmail=user%40example.com',
      }))

      expect(messagesAt(log, 'debug').join('\n')).not.toContain('accountEmail')
    })
  })

  describe('losing the connection', () => {
    it('reconnects after a backoff when the socket closes', async () => {
      await startOpen()

      currentSocket().emit('close', 1006)
      expect(requestToken).toHaveBeenCalledTimes(1)

      await openAfterReconnect(10_000)

      expect(requestToken).toHaveBeenCalledTimes(2)
      expect(MockWebSocket.instances).toHaveLength(2)
    })

    it('gives up and asks the caller to fall back to polling', async () => {
      requestToken.mockRejectedValue(new Error('no token for you'))

      await stream.start()
      for (let attempt = 0; attempt < 20 && onUnavailable.mock.calls.length === 0; attempt++) {
        await jest.advanceTimersByTimeAsync(WEBSOCKET_RECONNECT_MAX_MS)
      }

      expect(onUnavailable).toHaveBeenCalledTimes(1)
      expect(messagesAt(log, 'debug')).toContain(
        'Alarm.com event stream unavailable; falling back to polling. Will retry in 15 minutes.',
      )
      expect(messagesAt(log, 'warn')).not.toContain(
        'Alarm.com event stream unavailable; falling back to polling. Will retry in 15 minutes.',
      )
    })

    it('retries the stream after giving up, once the recovery interval elapses', async () => {
      requestToken.mockRejectedValue(new Error('no token for you'))

      await stream.start()
      for (let attempt = 0; attempt < 20 && onUnavailable.mock.calls.length === 0; attempt++) {
        await jest.advanceTimersByTimeAsync(WEBSOCKET_RECONNECT_MAX_MS)
      }
      expect(onUnavailable).toHaveBeenCalledTimes(1)

      requestToken.mockResolvedValue({ token: 'stream-token' })

      // Step only to the recovery timer. A bulk advance of the full recovery
      // interval would also expire the new handshake and burn another give-up.
      for (let step = 0; step < 50; step++) {
        await jest.advanceTimersToNextTimerAsync()
        await flushConnect()
        if (messagesAt(log, 'info').some((message) => (
          message.includes('Retrying the Alarm.com event stream after a prior give-up')
        ))) {
          break
        }
      }

      const recovered = currentSocket()
      expect(recovered.closeCount).toBe(0)
      recovered.readyState = MockWebSocket.OPEN
      recovered.emit('open')
      await flushConnect()

      expect(messagesAt(log, 'info')).toContain('Alarm.com event stream recovered; push updates resumed')
      expect(stream.isConnected).toBe(true)
    })

    /**
     * Failure reasons stay at debug; give-up is the loud line and carries the
     * latest reason. Token-fetch failures share the API breaker, so warning
     * here used to restate CLOSED -> OPEN (timeout, then breaker open).
     */
    it('records failure reasons at debug only', async () => {
      const { pending, socket } = await startPending()

      socket.emit('error', new Error('socket hang up'))
      socket.emit('error', new Error('certificate has expired'))
      socket.emit('close', 1006)
      await pending

      expect(messagesAt(log, 'warn')).toEqual([])
      expect(messagesAt(log, 'debug').join('\n')).toContain('event stream: socket hang up')
      expect(messagesAt(log, 'debug').join('\n')).toContain('event stream: certificate has expired')
    })

    it('reports the status code when the upgrade itself is refused', async () => {
      const { pending, socket } = await startPending()

      socket.emit('unexpected-response', {}, { statusCode: 401 })
      socket.emit('close', 1006)
      await pending

      expect(messagesAt(log, 'debug').join('\n')).toMatch(/refused the connection upgrade with HTTP 401/)
      expect(messagesAt(log, 'warn').join('\n')).not.toMatch(/refused the connection upgrade/)
    })

    it('keeps token-fetch failures quiet until a short give-up line', async () => {
      requestToken.mockRejectedValue(new Error('Circuit breaker is open. Service unavailable until 2099-01-01T00:00:00.000Z'))

      await stream.start()
      for (let attempt = 0; attempt < 20 && onUnavailable.mock.calls.length === 0; attempt++) {
        await jest.advanceTimersByTimeAsync(WEBSOCKET_RECONNECT_MAX_MS)
      }

      expect(messagesAt(log, 'debug').join('\n')).toMatch(/Circuit breaker is open/)
      expect(messagesAt(log, 'debug')).toContain(
        'Alarm.com event stream unavailable; falling back to polling. Will retry in 15 minutes.',
      )
      expect(messagesAt(log, 'warn')).toEqual([])
    })
  })

  describe('refreshing before the token expires', () => {
    it('reconnects on its own schedule even while the socket is healthy', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0)

      await startOpen()

      await openAfterReconnect(WEBSOCKET_REFRESH_INTERVAL_MS)

      expect(requestToken).toHaveBeenCalledTimes(2)
      expect(fixtureAt(MockWebSocket.instances, 0, 'sockets').closeCount).toBe(1)
      expect(messagesAt(log, 'debug')).toContain('Alarm.com event stream refreshed')
      expect(messagesAt(log, 'info')).not.toContain('Alarm.com event stream reconnected')
    })

    it('keeps the live socket until a refresh token arrives', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0)

      await startOpen()
      const firstSocket = currentSocket()

      let releaseToken!: (value: { token: string }) => void
      requestToken.mockImplementation(() => new Promise((resolve) => {
        releaseToken = resolve
      }))

      await jest.advanceTimersByTimeAsync(WEBSOCKET_REFRESH_INTERVAL_MS)
      await flushConnect()

      expect(firstSocket.closeCount).toBe(0)
      expect(stream.isConnected).toBe(true)
      expect(MockWebSocket.instances).toHaveLength(1)

      releaseToken({ token: 'next-token' })
      await flushConnect()
      const secondSocket = currentSocket()
      secondSocket.readyState = MockWebSocket.OPEN
      secondSocket.emit('open')
      await flushConnect()

      expect(firstSocket.closeCount).toBe(1)
      expect(MockWebSocket.instances).toHaveLength(2)
      expect(messagesAt(log, 'debug')).toContain('Alarm.com event stream refreshed')
    })

    it('keeps the live socket when a refresh token fetch fails', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0)

      await startOpen()
      const firstSocket = currentSocket()
      requestToken.mockRejectedValueOnce(new Error('token endpoint down'))

      await jest.advanceTimersByTimeAsync(WEBSOCKET_REFRESH_INTERVAL_MS)
      await flushConnect()

      expect(firstSocket.closeCount).toBe(0)
      expect(stream.isConnected).toBe(true)
      expect(messagesAt(log, 'warn').join('\n')).not.toMatch(/could not obtain a stream token/)
      expect(messagesAt(log, 'debug').join('\n')).toMatch(/keeping the live socket/)
    })

    it('still WARNs about a later drop failure after a quiet refresh-token miss', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0)

      await startOpen()
      requestToken.mockRejectedValueOnce(new Error('token endpoint down'))

      await jest.advanceTimersByTimeAsync(WEBSOCKET_REFRESH_INTERVAL_MS)
      await flushConnect()
      expect(messagesAt(log, 'warn')).toHaveLength(0)

      requestToken.mockRejectedValue(new Error('still no token'))
      currentSocket().emit('close', 1006)
      await jest.advanceTimersByTimeAsync(WEBSOCKET_RECONNECT_BASE_MS)
      await flushConnect()

      // Already connected once — token failures on the drop path stay at debug
      // until give-up, which is what carries the last error at warn.
      expect(messagesAt(log, 'warn')).toEqual([])
      expect(messagesAt(log, 'debug').join('\n')).toContain(
        'event stream: could not obtain a stream token: still no token',
      )
    })

    it('abandons a deferred refresh when the socket drops and recovers during the token fetch', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0)

      await startOpen()
      const firstSocket = currentSocket()

      let releaseRefreshToken!: (value: { token: string }) => void
      let isRefreshTokenPending = true
      requestToken.mockImplementation(() => {
        if (isRefreshTokenPending) {
          isRefreshTokenPending = false
          return new Promise((resolve) => {
            releaseRefreshToken = resolve
          })
        }
        return Promise.resolve({ token: 'recovered-token' })
      })

      await jest.advanceTimersByTimeAsync(WEBSOCKET_REFRESH_INTERVAL_MS)
      await flushConnect()
      expect(requestToken).toHaveBeenCalledTimes(2)

      firstSocket.readyState = 3
      firstSocket.emit('close', 1006)
      const recovered = await openAfterReconnect(WEBSOCKET_RECONNECT_BASE_MS)
      expect(stream.isConnected).toBe(true)
      expect(messagesAt(log, 'debug')).toContain('Alarm.com event stream reconnected')
      expect(messagesAt(log, 'info')).not.toContain('Alarm.com event stream reconnected')

      const socketsBeforeStaleResume = MockWebSocket.instances.length
      releaseRefreshToken({ token: 'stale-refresh-token' })
      await flushConnect()
      await flushConnect()

      expect(MockWebSocket.instances).toHaveLength(socketsBeforeStaleResume)
      expect(recovered.closeCount).toBe(0)
      expect(stream.isConnected).toBe(true)
      expect(messagesAt(log, 'debug')).not.toContain('Alarm.com event stream refreshed')
    })

    it('keeps the live socket when a refresh handshake times out', async () => {
      const onReconnect = jest.fn()
      stream = new EventStream({
        log,
        requestToken: requestToken,
        onDeviceEvent: onDeviceEvent,
        onUnavailable: onUnavailable,
        onReconnect: onReconnect,
      })
      jest.spyOn(Math, 'random').mockReturnValue(0)

      await startOpen()
      const live = currentSocket()

      await jest.advanceTimersByTimeAsync(WEBSOCKET_REFRESH_INTERVAL_MS)
      await flushConnect()
      expect(MockWebSocket.instances).toHaveLength(2)
      const candidate = currentSocket()

      await jest.advanceTimersByTimeAsync(WEBSOCKET_HANDSHAKE_TIMEOUT_MS)
      await flushConnect()

      expect(live.closeCount).toBe(0)
      expect(stream.isConnected).toBe(true)
      expect(candidate.closeCount).toBe(1)
      expect(onReconnect).not.toHaveBeenCalled()
      expect(messagesAt(log, 'info')).not.toContain('Alarm.com event stream reconnected')
      expect(messagesAt(log, 'warn').join('\n')).not.toMatch(/handshake timed out/)
      expect(messagesAt(log, 'debug').join('\n')).toMatch(/refresh handshake timed out/)
      expect(messagesAt(log, 'debug').join('\n')).toMatch(/keeping the live socket/)
    })

    it('abandons a refresh candidate when the live socket drops mid-handshake', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0)

      await startOpen()
      const live = currentSocket()

      await jest.advanceTimersByTimeAsync(WEBSOCKET_REFRESH_INTERVAL_MS)
      await flushConnect()
      expect(MockWebSocket.instances).toHaveLength(2)
      const candidate = currentSocket()

      live.readyState = MockWebSocket.CLOSED
      live.emit('close', 1006)
      await flushConnect()

      expect(candidate.closeCount).toBe(1)

      await openAfterReconnect(WEBSOCKET_RECONNECT_BASE_MS)
      expect(stream.isConnected).toBe(true)
      expect(messagesAt(log, 'debug')).toContain('Alarm.com event stream reconnected')
      expect(messagesAt(log, 'info')).not.toContain('Alarm.com event stream reconnected')
    })

    it('keeps every mid-session reconnect at debug', async () => {
      await startOpen()

      currentSocket().emit('close', 1006)
      await openAfterReconnect(WEBSOCKET_RECONNECT_BASE_MS)
      currentSocket().emit('close', 1006)
      await openAfterReconnect(WEBSOCKET_RECONNECT_BASE_MS)

      expect(messagesAt(log, 'info').filter((message) => (
        message === 'Alarm.com event stream reconnected'
      ))).toHaveLength(0)
      expect(messagesAt(log, 'debug').filter((message) => (
        message === 'Alarm.com event stream reconnected'
      )).length).toBeGreaterThanOrEqual(2)
    })

    it('does not WARN when a deferred refresh token fails while drop reconnect is pending', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0)

      await startOpen()
      const firstSocket = currentSocket()

      let rejectRefreshToken!: (error: Error) => void
      let isRefreshTokenPending = true
      requestToken.mockImplementation(() => {
        if (isRefreshTokenPending) {
          isRefreshTokenPending = false
          return new Promise((_resolve, reject) => {
            rejectRefreshToken = reject
          })
        }
        return Promise.resolve({ token: 'recovered-token' })
      })

      await jest.advanceTimersByTimeAsync(WEBSOCKET_REFRESH_INTERVAL_MS)
      await flushConnect()

      firstSocket.readyState = 3
      firstSocket.emit('close', 1006)
      await flushConnect()

      rejectRefreshToken(new Error('stale refresh token failed while drop pending'))
      await flushConnect()
      await flushConnect()

      expect(messagesAt(log, 'warn').join('\n')).not.toMatch(/stale refresh token failed/)
      expect(messagesAt(log, 'debug').join('\n')).toMatch(/abandoned refresh token fetch after drop/)

      await openAfterReconnect(WEBSOCKET_RECONNECT_BASE_MS)
      expect(stream.isConnected).toBe(true)
    })

    it('does not schedule a competing reconnect when a deferred refresh token fails after drop recovery', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0)

      await startOpen()
      const firstSocket = currentSocket()

      let rejectRefreshToken!: (error: Error) => void
      let isRefreshTokenPending = true
      requestToken.mockImplementation(() => {
        if (isRefreshTokenPending) {
          isRefreshTokenPending = false
          return new Promise((_resolve, reject) => {
            rejectRefreshToken = reject
          })
        }
        return Promise.resolve({ token: 'recovered-token' })
      })

      await jest.advanceTimersByTimeAsync(WEBSOCKET_REFRESH_INTERVAL_MS)
      await flushConnect()

      firstSocket.readyState = 3
      firstSocket.emit('close', 1006)
      const recovered = await openAfterReconnect(WEBSOCKET_RECONNECT_BASE_MS)
      const socketsAfterRecovery = MockWebSocket.instances.length
      const tokenCallsAfterRecovery = requestToken.mock.calls.length

      rejectRefreshToken(new Error('stale refresh token failed'))
      await flushConnect()
      await flushConnect()
      await jest.advanceTimersByTimeAsync(WEBSOCKET_RECONNECT_BASE_MS)
      await flushConnect()

      expect(MockWebSocket.instances).toHaveLength(socketsAfterRecovery)
      expect(requestToken).toHaveBeenCalledTimes(tokenCallsAfterRecovery)
      expect(recovered.closeCount).toBe(0)
      expect(stream.isConnected).toBe(true)
      expect(messagesAt(log, 'warn').join('\n')).not.toMatch(/stale refresh token failed/)
    })

    it('cancels a pending refresh when the socket drops, so only one reconnect runs', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0)

      await startOpen()
      await jest.advanceTimersByTimeAsync(WEBSOCKET_REFRESH_INTERVAL_MS - 1_000)
      currentSocket().emit('close', 1006)

      // Refresh would have been due in 1s; it must not fire. Only the drop backoff.
      await openAfterReconnect(WEBSOCKET_RECONNECT_BASE_MS)

      expect(MockWebSocket.instances).toHaveLength(2)
      expect(messagesAt(log, 'debug')).toContain('Alarm.com event stream reconnected')
      expect(messagesAt(log, 'info')).not.toContain('Alarm.com event stream reconnected')
      expect(messagesAt(log, 'debug')).not.toContain('Alarm.com event stream refreshed')
    })
  })

  describe('stop', () => {
    it('closes the socket and leaves no timer behind', async () => {
      await startOpen()
      expect(jest.getTimerCount()).toBeGreaterThan(0)

      stream.stop()

      expect(jest.getTimerCount()).toBe(0)
      expect(fixtureAt(MockWebSocket.instances, 0, 'sockets').closeCount).toBe(1)
    })

    it('cancels a pending reconnect', async () => {
      const { pending, socket } = await startPending()
      socket.emit('close', 1006)
      await pending
      expect(jest.getTimerCount()).toBe(1)

      stream.stop()

      expect(jest.getTimerCount()).toBe(0)
    })

    it('does not reconnect when the socket closes afterwards', async () => {
      const { pending, socket } = await startPending()

      stream.stop()
      socket.emit('close', 1000)
      await pending
      await jest.advanceTimersByTimeAsync(300_000)

      expect(requestToken).toHaveBeenCalledTimes(1)
    })

    it('does not hang or crash when stop interrupts an in-flight handshake', async () => {
      const { pending, socket } = await startPending()
      expect(socket.readyState).toBe(MockWebSocket.CONNECTING)

      expect(() => stream.stop()).not.toThrow()
      await pending

      expect(socket.closeCount).toBe(1)
      expect(socket.readyState).toBe(MockWebSocket.CLOSED)
      expect(stream.isConnected).toBe(false)
    })

    it('can start again after being stopped mid-handshake', async () => {
      const { pending, socket } = await startPending()

      expect(() => stream.stop()).not.toThrow()
      await pending
      expect(socket.readyState).toBe(MockWebSocket.CLOSED)

      await startOpen()

      expect(MockWebSocket.instances).toHaveLength(2)
      expect(messagesAt(log, 'info')).toContain('Alarm.com event stream connected')
      expect(stream.isConnected).toBe(true)
    })
  })
})
