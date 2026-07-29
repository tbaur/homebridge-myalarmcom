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
  WEBSOCKET_MAX_FAILURES,
  WEBSOCKET_REFRESH_INTERVAL_MS,
} from '../../../src/settings'
import { createRecordingLogger, messagesAt, type RecordingLogger } from '../../helpers/logger'
import eventsFixture from '../../fixtures/events.json'

jest.mock('ws', () => {
  const { EventEmitter: NodeEventEmitter } = jest.requireActual<typeof import('node:events')>('node:events')

  class MockWebSocket extends NodeEventEmitter {
    static readonly OPEN = 1
    static readonly instances: MockWebSocket[] = []

    readyState = 0
    closeCount = 0

    constructor(readonly url: string) {
      super()
      MockWebSocket.instances.push(this)
    }

    close(): void {
      this.closeCount++
      this.readyState = 3
    }
  }

  return MockWebSocket
})

interface MockSocket extends EventEmitter {
  url: string
  readyState: number
  closeCount: number
}

const MockWebSocket = WebSocket as unknown as { OPEN: number, instances: MockSocket[] }

const [signInEvent, deviceEvent] = eventsFixture.events as AlarmComEvent[]

describe('EventStream', () => {
  let log: RecordingLogger
  let requestToken: jest.Mock
  let onDeviceEvent: jest.Mock
  let onUnavailable: jest.Mock
  let stream: EventStream

  function createStream(): EventStream {
    return new EventStream({
      log,
      requestToken: requestToken as unknown as () => Promise<{ token: string, endpoint?: string }>,
      onDeviceEvent: onDeviceEvent as unknown as (id: string, event: AlarmComEvent) => void,
      onUnavailable: onUnavailable as unknown as () => void,
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
    jest.useRealTimers()
  })

  describe('connecting', () => {
    it('opens the endpoint Alarm.com named, carrying the token', async () => {
      requestToken.mockResolvedValue({ token: 'stream-token', endpoint: 'wss://webskt-eu.alarm.com:8443' })

      await stream.start()

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

        await stream.start()

        expect(currentSocket().url).toBe(`${DEFAULT_WEBSOCKET_ENDPOINT}?auth=stream-token`)
        expect(messagesAt(log, 'warn').join('\n')).toMatch(/event stream endpoint/i)
      })

      it('accepts the canonical host itself, not only its subdomains', async () => {
        requestToken.mockResolvedValue({ token: 'stream-token', endpoint: 'wss://alarm.com:8443' })

        await stream.start()

        expect(currentSocket().url).toBe('wss://alarm.com:8443?auth=stream-token')
      })
    })

    it('falls back to the default endpoint when none was supplied', async () => {
      await stream.start()

      expect(currentSocket().url).toBe(`${DEFAULT_WEBSOCKET_ENDPOINT}?auth=stream-token`)
    })

    it('appends the token verbatim, since it already carries its own separators', async () => {
      requestToken.mockResolvedValue({ token: 'id%3D42&sig%3Dabc' })

      await stream.start()

      expect(currentSocket().url).toBe(`${DEFAULT_WEBSOCKET_ENDPOINT}?auth=id%3D42&sig%3Dabc`)
    })

    it('reports itself connected only once the socket is open', async () => {
      await stream.start()
      expect(stream.isConnected).toBe(false)

      currentSocket().readyState = 1
      expect(stream.isConnected).toBe(true)
    })
  })

  describe('incoming frames', () => {
    beforeEach(async () => {
      await stream.start()
      currentSocket().emit('open')
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
      await stream.start()
      currentSocket().emit('open')

      currentSocket().emit('close', 1006)
      expect(requestToken).toHaveBeenCalledTimes(1)

      await jest.advanceTimersByTimeAsync(10_000)

      expect(requestToken).toHaveBeenCalledTimes(2)
      expect(MockWebSocket.instances).toHaveLength(2)
    })

    it('gives up and asks the caller to fall back to polling', async () => {
      requestToken.mockRejectedValue(new Error('no token for you'))

      await stream.start()
      for (let attempt = 0; attempt < WEBSOCKET_MAX_FAILURES; attempt++) {
        await jest.advanceTimersByTimeAsync(300_000)
      }

      expect(onUnavailable).toHaveBeenCalledTimes(1)
      expect(messagesAt(log, 'warn').join('\n')).toMatch(/falling back to polling/)
    })

    it('explains the first failure loudly and the rest quietly', async () => {
      await stream.start()

      currentSocket().emit('error', new Error('socket hang up'))
      currentSocket().emit('error', new Error('socket hang up again'))

      expect(messagesAt(log, 'warn')).toEqual([
        'Alarm.com event stream could not connect: socket hang up',
      ])
      expect(messagesAt(log, 'debug').join('\n')).toContain('socket hang up again')
    })

    it('reports the status code when the upgrade itself is refused', async () => {
      await stream.start()

      currentSocket().emit('unexpected-response', {}, { statusCode: 401 })

      expect(messagesAt(log, 'warn').join('\n')).toMatch(/refused the connection upgrade with HTTP 401/)
    })

    it('is willing to complain again after a successful connection in between', async () => {
      await stream.start()
      currentSocket().emit('error', new Error('first failure'))
      currentSocket().emit('open')

      currentSocket().emit('error', new Error('later failure'))

      expect(messagesAt(log, 'warn')).toHaveLength(2)
    })
  })

  describe('refreshing before the token expires', () => {
    it('reconnects on its own schedule even while the socket is healthy', async () => {
      await stream.start()
      currentSocket().emit('open')

      await jest.advanceTimersByTimeAsync(WEBSOCKET_REFRESH_INTERVAL_MS + 15_001)

      expect(requestToken).toHaveBeenCalledTimes(2)
      expect(MockWebSocket.instances[0].closeCount).toBe(1)
    })
  })

  describe('stop', () => {
    it('closes the socket and leaves no timer behind', async () => {
      await stream.start()
      currentSocket().emit('open')
      expect(jest.getTimerCount()).toBeGreaterThan(0)

      stream.stop()

      expect(jest.getTimerCount()).toBe(0)
      expect(MockWebSocket.instances[0].closeCount).toBe(1)
    })

    it('cancels a pending reconnect', async () => {
      await stream.start()
      currentSocket().emit('close', 1006)
      expect(jest.getTimerCount()).toBe(1)

      stream.stop()

      expect(jest.getTimerCount()).toBe(0)
    })

    it('does not reconnect when the socket closes afterwards', async () => {
      await stream.start()
      const socket = currentSocket()

      stream.stop()
      socket.emit('close', 1000)
      await jest.advanceTimersByTimeAsync(300_000)

      expect(requestToken).toHaveBeenCalledTimes(1)
    })

    it('opens nothing if it is stopped before it starts', async () => {
      stream.stop()

      await stream.start()

      expect(MockWebSocket.instances).toHaveLength(1)
    })
  })
})
