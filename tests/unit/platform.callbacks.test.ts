/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The callbacks the platform hands to its collaborators, and the timer it arms
 * for the session keep-alive.
 *
 * These were the least-covered part of the plugin, and the coverage config
 * described them as "asserted where they originate instead" — which was not true
 * of any of them. The keep-alive is the mechanism the whole session-lifetime
 * design rests on, and the stream-unavailable warning is the one line a user
 * landing on the matching troubleshooting entry is looking for; both existed
 * nowhere else, so nothing was asserting either.
 *
 * The `EventStream` is replaced by a double that captures its options, so the
 * platform's own wiring runs while the socket does not.
 */

import nock from 'nock'
import { SessionManager } from '../../src/api/session-manager'
import { MyAlarmComPlatform } from '../../src/platform'
import { BASE_URL, KEEPALIVE_INTERVAL_MS } from '../../src/settings'
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

jest.mock('../../src/utils/retry', () => {
  const actual = jest.requireActual<typeof import('../../src/utils/retry')>('../../src/utils/retry')
  return { ...actual, sleep: () => Promise.resolve() }
})

/** Options the platform passed to the stream, captured by the double below. */
interface CapturedStreamOptions {
  onUnavailable?: () => void
  onRecovered?: () => void
}

let capturedStreamOptions: CapturedStreamOptions | null = null

jest.mock('../../src/api/event-stream', () => ({
  EventStream: class {
    constructor(options: CapturedStreamOptions) {
      capturedStreamOptions = options
    }

    start(): Promise<void> {
      return Promise.resolve()
    }

    stop(): void {
      // no-op
    }

    getStatus(): null {
      return null
    }
  },
}))

const CONFIG: MyAlarmComPlatformConfig = {
  platform: 'MyAlarmCom',
  username: 'user@example.com',
  password: 'correct-horse-battery',
  twoFactorAuthenticationId: 'a'.repeat(64),
  useEventStream: true,
  pollIntervalSeconds: 3600,
  authIntervalMinutes: 60,
  // The keep-alive reports at debug, because a single unconfirmed touch is not
  // something a user can act on — the session manager escalates after three.
  debug: true,
}

const LOGIN_PAGE_HTML = ['__VIEWSTATE', '__VIEWSTATEGENERATOR', '__EVENTVALIDATION', '__PREVIOUSPAGE']
  .map((name) => `<input type="hidden" name="${name}" value="${name}-value" />`)
  .join('\n')

function interceptSignIn(): void {
  nock(BASE_URL).get('/login').reply(200, LOGIN_PAGE_HTML)
  nock(BASE_URL).post('/web/Default.aspx').reply(302, '', [
    'Set-Cookie', 'ASP.NET_SessionId=session-value; path=/; HttpOnly',
    'Set-Cookie', 'afg=csrf-value; path=/',
  ])
}

function replyWithRequested(resources: { id: string }[]) {
  return (uri: string): { data: { id: string }[] } => {
    const requested = new URL(uri, BASE_URL).searchParams.getAll('ids[]')
    return { data: resources.filter((resource) => requested.includes(resource.id)) }
  }
}

function interceptDiscovery(): void {
  nock(BASE_URL).get('/web/api/identities').reply(200, identitiesFixture)
  nock(BASE_URL).get('/web/api/systems/systems/7654321').reply(200, systemFixture)
  nock(BASE_URL).get('/web/api/websockets/token').optionally()
    .reply(200, { value: 'stream-token', metaData: {} })
  nock(BASE_URL)
    .get('/web/api/devices/partitions')
    .query(true)
    .reply(200, replyWithRequested(partitionsFixture.data))
  nock(BASE_URL)
    .get('/web/api/devices/sensors')
    .query(true)
    .reply(200, replyWithRequested(sensorsFixture.data))
}

describe('platform collaborator callbacks', () => {
  let api: FakeHomebridgeApi
  let log: RecordingLogging
  let keepAliveTick: (() => void) | null
  let setIntervalSpy: jest.SpyInstance

  async function launch(): Promise<MyAlarmComPlatform> {
    const platform = new MyAlarmComPlatform(log, CONFIG, api.asApi())
    api.emit('didFinishLaunching')
    await waitFor(
      () => log.infoMessages.some((message) => message.includes('Ready')) || log.errors.length > 0,
      { description: 'discovery to finish' },
    )
    return platform
  }

  beforeEach(() => {
    api = new FakeHomebridgeApi()
    log = createHomebridgeLogging()
    capturedStreamOptions = null
    keepAliveTick = null
    interceptSignIn()
    interceptDiscovery()

    // The keep-alive is identified by its interval, which the config keeps clear
    // of the poll interval. Asserted rather than assumed, so a constant drifting
    // into collision fails here rather than as a confusing null dereference.
    expect(KEEPALIVE_INTERVAL_MS).not.toBe(Number(CONFIG.pollIntervalSeconds) * 1_000)

    const realSetInterval = global.setInterval.bind(global)
    setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation((handler, timeout) => {
      if (timeout === KEEPALIVE_INTERVAL_MS && typeof handler === 'function') {
        keepAliveTick = handler
      }
      return realSetInterval(handler, timeout as number)
    })
  })

  afterEach(() => {
    api.emit('shutdown')
    setIntervalSpy.mockRestore()
    nock.cleanAll()
  })

  describe('the session keep-alive tick', () => {
    it('is armed once the platform is ready', async () => {
      await launch()

      expect(keepAliveTick).not.toBeNull()
    })

    it('says so when the keep-alive cannot confirm a live session', async () => {
      const touch = jest.spyOn(SessionManager.prototype, 'touch').mockResolvedValue(false)
      await launch()

      keepAliveTick!()
      expect(touch).toHaveBeenCalled()
      await waitFor(
        () => log.debugMessages.some((message) => message.includes('did not confirm a live session')),
        { description: 'the keep-alive to report an unconfirmed session' },
      )
    })

    /**
     * A rejected keep-alive must not become an unhandled rejection. The tick is
     * fired from a timer, so nothing is waiting to catch it.
     */
    it('absorbs a keep-alive that rejects outright', async () => {
      jest.spyOn(SessionManager.prototype, 'touch')
        .mockRejectedValue(new Error('socket hang up'))
      await launch()

      expect(() => keepAliveTick!()).not.toThrow()
      await waitFor(
        () => log.debugMessages.some((message) => message.includes('keep-alive tick failed')),
        { description: 'the failed tick to be reported' },
      )
    })
  })

  describe('the event stream callbacks', () => {
    it('tells the user push updates are gone and polling has taken over', async () => {
      await launch()
      expect(capturedStreamOptions?.onUnavailable).toBeDefined()

      capturedStreamOptions!.onUnavailable!()

      expect(log.warnings.join('\n')).toMatch(/Continuing with polling only/)
      expect(log.warnings.join('\n')).toMatch(/slower/)
    })

    it('does not add a second recovery line, which the stream already reports', async () => {
      await launch()
      log.warnings.length = 0
      log.infoMessages.length = 0

      capturedStreamOptions?.onRecovered?.()

      expect(log.warnings).toEqual([])
      expect(log.infoMessages).toEqual([])
    })
  })
})
