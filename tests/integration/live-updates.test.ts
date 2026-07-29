/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * What happens after discovery: a pushed frame, the immediate state it
 * publishes, the confirming re-read that overrules it, and the timers that
 * have to stop when Homebridge shuts down. The socket is a hand-driven
 * emitter and the poll interval is the only faked timer, so the HTTP under
 * test still runs on real I/O.
 */

import type { EventEmitter } from 'node:events'
import nock from 'nock'
import WebSocket from 'ws'
import { MyAlarmComPlatform } from '../../src/platform'
import { BASE_URL } from '../../src/settings'
import type { AlarmComEvent } from '../../src/types/events'
import type { MyAlarmComPlatformConfig } from '../../src/types/config'
import {
  createHomebridgeLogging,
  FakeHomebridgeApi,
  waitFor,
  type RecordingLogging,
} from '../helpers/homekit'
import identitiesFixture from '../fixtures/identities.json'
import partitionsFixture from '../fixtures/partitions.json'
import sensorsFixture from '../fixtures/sensors.json'
import systemFixture from '../fixtures/system.json'
import eventsFixture from '../fixtures/events.json'

jest.mock('../../src/utils/retry', () => {
  const actual = jest.requireActual<typeof import('../../src/utils/retry')>('../../src/utils/retry')
  return { ...actual, sleep: () => Promise.resolve() }
})

jest.mock('ws', () => {
  const { EventEmitter: NodeEventEmitter } = jest.requireActual<typeof import('node:events')>('node:events')

  class MockWebSocket extends NodeEventEmitter {
    static readonly OPEN = 1
    static readonly instances: MockWebSocket[] = []

    readyState = 1

    constructor(readonly url: string) {
      super()
      MockWebSocket.instances.push(this)
    }

    close(): void {
      this.readyState = 3
    }
  }

  return MockWebSocket
})

const MockWebSocket = WebSocket as unknown as { instances: (EventEmitter & { url: string })[] }

const CONFIG: MyAlarmComPlatformConfig = {
  platform: 'MyAlarmCom',
  username: 'user@example.com',
  password: 'correct-horse-battery',
  twoFactorAuthenticationId: 'a'.repeat(64),
  useEventStream: true,
}

const LOGIN_PAGE_HTML = ['__VIEWSTATE', '__VIEWSTATEGENERATOR', '__EVENTVALIDATION', '__PREVIOUSPAGE']
  .map((name) => `<input type="hidden" name="${name}" value="${name}-value" />`)
  .join('\n')

const FRONT_DOOR = '1234567-1'
const KITCHEN_WINDOW = '1234567-2'

/** A contact opening, which the plugin is willing to publish before re-reading. */
const DOOR_OPENED: AlarmComEvent = {
  EventDateUtc: '2026-07-29T02:05:00.000Z',
  UnitId: 1234567,
  DeviceId: 1,
  EventType: 15,
  EventValue: 0,
  CorrelatedId: null,
  QstringForExtraData: null,
  DeviceType: 1,
}

const [signInEvent, openAndClosedEvent] = eventsFixture.events as AlarmComEvent[]

/** Fake only the poll interval, so the requests it triggers still run for real. */
function useOnlyPollTimer(): void {
  jest.useFakeTimers({
    doNotFake: [
      'setTimeout',
      'clearTimeout',
      'setImmediate',
      'clearImmediate',
      'nextTick',
      'queueMicrotask',
      'Date',
      'performance',
    ],
  })
}

describe('staying up to date after discovery', () => {
  let api: FakeHomebridgeApi
  let log: RecordingLogging
  let sensorReads: string[][]

  function requestedIds(uri: string): string[] {
    return new URL(uri, BASE_URL).searchParams.getAll('ids[]')
  }

  function interceptEverything(): void {
    nock(BASE_URL).get('/login').reply(200, LOGIN_PAGE_HTML)
    nock(BASE_URL).post('/web/Default.aspx').reply(302, '', [
      'Set-Cookie', 'ASP.NET_SessionId=session-value; path=/; HttpOnly',
      'Set-Cookie', 'afg=csrf-value; path=/',
    ])
    nock(BASE_URL).get('/web/api/identities').reply(200, identitiesFixture)
    nock(BASE_URL).get('/web/api/systems/systems/7654321').reply(200, systemFixture)
    nock(BASE_URL)
      .get('/web/api/websockets/token')
      .reply(200, { value: 'stream-token', metaData: { endpoint: 'wss://webskt.alarm.com:8443' } })

    nock(BASE_URL)
      .persist()
      .get('/web/api/devices/partitions')
      .query(true)
      .reply(200, (uri: string) => ({
        data: partitionsFixture.data.filter((partition) => requestedIds(uri).includes(partition.id)),
      }))

    nock(BASE_URL)
      .persist()
      .get('/web/api/devices/sensors')
      .query(true)
      .reply(200, (uri: string) => {
        const ids = requestedIds(uri)
        sensorReads.push(ids)
        return { data: sensorsFixture.data.filter((sensor) => ids.includes(sensor.id)) }
      })
  }

  async function launch(): Promise<void> {
    new MyAlarmComPlatform(log, CONFIG, api.asApi())
    api.emit('didFinishLaunching')
    await waitFor(
      () => log.infoMessages.some((message) => message.includes('Polling Alarm.com every')),
      { description: 'discovery to finish' },
    )
  }

  async function waitForSocket(): Promise<void> {
    await waitFor(() => MockWebSocket.instances.length > 0, { description: 'the event stream to connect' })
  }

  /** Deliver a frame the way the socket would. */
  function pushEvent(event: AlarmComEvent): void {
    const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1]
    if (!socket) {
      throw new Error('The platform never opened a socket')
    }
    socket.emit('message', Buffer.from(JSON.stringify(event)))
  }

  function contactStateOf(displayName: string): unknown {
    const accessory = api.registered.find((candidate) => candidate.displayName === displayName)
    return accessory?.services
      .flatMap((service) => service.characteristics)
      .find((characteristic) => characteristic.UUID === api.hap.Characteristic.ContactSensorState.UUID)
      ?.value
  }

  /** A targeted re-read asks for exactly one device; discovery asks for many. */
  function targetedReadsOf(deviceId: string): string[][] {
    return sensorReads.filter((ids) => ids.length === 1 && ids[0] === deviceId)
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }

  beforeEach(() => {
    api = new FakeHomebridgeApi()
    log = createHomebridgeLogging()
    sensorReads = []
    MockWebSocket.instances.length = 0
    interceptEverything()
  })

  afterEach(() => {
    jest.useRealTimers()
    api.emit('shutdown')
  })

  it('publishes an opened door immediately rather than waiting for the re-read', async () => {
    await launch()
    await waitForSocket()
    expect(contactStateOf('Front Door')).toBe(api.hap.Characteristic.ContactSensorState.CONTACT_DETECTED)

    pushEvent(DOOR_OPENED)

    expect(contactStateOf('Front Door')).toBe(api.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED)
  })

  /**
   * The immediate value is a guess and the read that follows is the truth. The
   * account still reports the door closed, so the guess must not survive.
   */
  it('lets the confirming re-read overrule the state it guessed', async () => {
    await launch()
    await waitForSocket()

    pushEvent(DOOR_OPENED)

    await waitFor(
      () => contactStateOf('Front Door') === api.hap.Characteristic.ContactSensorState.CONTACT_DETECTED,
      { description: 'the guessed state to be corrected', timeoutMs: 5_000 },
    )
    expect(targetedReadsOf(FRONT_DOOR)).toHaveLength(1)
  })

  it('collapses a burst of frames for one device into a single re-read', async () => {
    await launch()
    await waitForSocket()

    pushEvent(openAndClosedEvent)
    pushEvent(openAndClosedEvent)
    pushEvent(openAndClosedEvent)
    await waitFor(() => targetedReadsOf(KITCHEN_WINDOW).length > 0, {
      description: 'the coalesced re-read',
      timeoutMs: 5_000,
    })
    await settle()

    expect(targetedReadsOf(KITCHEN_WINDOW)).toHaveLength(1)
  })

  it('ignores a sign-in frame, which says nothing about any device', async () => {
    await launch()
    await waitForSocket()
    const readsAfterDiscovery = sensorReads.length

    pushEvent(signInEvent)
    await settle()

    expect(sensorReads).toHaveLength(readsAfterDiscovery)
  })

  it('discards a frame it cannot parse without falling over', async () => {
    await launch()
    await waitForSocket()
    const readsAfterDiscovery = sensorReads.length

    const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1]
    socket?.emit('message', Buffer.from('<html>not a frame</html>'))
    await settle()

    expect(sensorReads).toHaveLength(readsAfterDiscovery)
    expect(log.errors).toEqual([])
  })

  it('re-reads every device when the poll timer fires', async () => {
    useOnlyPollTimer()
    await launch()
    sensorReads.length = 0

    jest.advanceTimersByTime(60_000)
    jest.useRealTimers()

    await waitFor(() => sensorReads.length > 0, { description: 'the poll to issue a read' })
    expect(sensorReads[0]).toEqual([FRONT_DOOR, KITCHEN_WINDOW, '1234567-15', '1234567-16'])
  })

  it('stops polling once Homebridge shuts down', async () => {
    useOnlyPollTimer()
    await launch()
    api.emit('shutdown')
    sensorReads.length = 0

    jest.advanceTimersByTime(5 * 60_000)
    jest.useRealTimers()
    await settle()

    expect(sensorReads).toEqual([])
  })
})
