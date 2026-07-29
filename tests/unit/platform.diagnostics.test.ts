/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Platform-level diagnostics wiring: start/stop snapshots, heartbeats, and
 * health transitions. Discovery is exercised over nock so the real lifecycle
 * path (`didFinishLaunching` → discover → `#startDiagnostics`) is what runs.
 */

import nock from 'nock'
import { MyAlarmComPlatform } from '../../src/platform'
import { BASE_URL } from '../../src/settings'
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

const CONFIG: MyAlarmComPlatformConfig = {
  platform: 'MyAlarmCom',
  username: 'user@example.com',
  password: 'correct-horse-battery',
  twoFactorAuthenticationId: 'a'.repeat(64),
  useEventStream: false,
  pollIntervalSeconds: 3600,
  authIntervalMinutes: 60,
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
  nock(BASE_URL)
    .get('/web/api/devices/partitions')
    .query(true)
    .reply(200, replyWithRequested(partitionsFixture.data))
  nock(BASE_URL)
    .get('/web/api/devices/sensors')
    .query(true)
    .reply(200, replyWithRequested(sensorsFixture.data))
}

describe('platform diagnostics', () => {
  let api: FakeHomebridgeApi
  let log: RecordingLogging
  let platform: MyAlarmComPlatform
  let diagnosticsHeartbeat: (() => void) | null
  let setIntervalSpy: jest.SpyInstance

  async function waitForDiscovery(): Promise<void> {
    await waitFor(
      () => log.infoMessages.some((message) => message.includes('Polling Alarm.com every'))
        || log.errors.length > 0,
      { description: 'discovery to finish' },
    )
  }

  async function launch(overrides: Partial<MyAlarmComPlatformConfig> = {}): Promise<MyAlarmComPlatform> {
    platform = new MyAlarmComPlatform(log, { ...CONFIG, ...overrides }, api.asApi())
    api.emit('didFinishLaunching')
    await waitForDiscovery()
    return platform
  }

  beforeEach(() => {
    api = new FakeHomebridgeApi()
    log = createHomebridgeLogging()
    diagnosticsHeartbeat = null
    interceptSignIn()
    interceptDiscovery()

    const realSetInterval = global.setInterval.bind(global)
    setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation((handler, timeout) => {
      if (timeout === 60_000 && typeof handler === 'function') {
        diagnosticsHeartbeat = handler as () => void
      }
      return realSetInterval(handler as () => void, timeout as number)
    })
  })

  afterEach(() => {
    api.emit('shutdown')
    setIntervalSpy.mockRestore()
    nock.cleanAll()
  })

  it('emits no diagnostics output when diagnosticsInterval is 0 (default)', async () => {
    await launch()

    expect(log.infoMessages.some((message) => message.includes('Diagnostics start'))).toBe(false)
    expect(diagnosticsHeartbeat).toBeNull()
  })

  it('emits a start snapshot and periodic heartbeats when enabled', async () => {
    await launch({ diagnosticsInterval: 60 })

    expect(log.infoMessages.some((message) => message.includes('Diagnostics start'))).toBe(true)
    expect(diagnosticsHeartbeat).not.toBeNull()

    const infoBefore = log.infoMessages.length
    diagnosticsHeartbeat!()
    expect(log.infoMessages.slice(infoBefore).some((message) => message.includes('Health:'))).toBe(true)

    const afterFirst = log.infoMessages.length
    diagnosticsHeartbeat!()
    expect(
      log.infoMessages.slice(afterFirst).filter((message) => message.includes('Health:')).length,
    ).toBe(1)
  })

  it('emits a stop snapshot on shutdown', async () => {
    await launch({ diagnosticsInterval: 60 })
    log.infoMessages.length = 0

    api.emit('shutdown')

    expect(log.infoMessages.some((message) => message.includes('Diagnostics stop'))).toBe(true)
  })

  it('logs a degraded transition when the circuit breaker opens', async () => {
    await launch({ diagnosticsInterval: 60 })
    expect(diagnosticsHeartbeat).not.toBeNull()

    jest.spyOn(platform.client, 'getStatus').mockReturnValue({
      circuitBreaker: { state: 'OPEN' },
      rateLimiter: { remaining: 100 },
      hasSession: true,
    })

    log.warnings.length = 0
    diagnosticsHeartbeat!()

    expect(log.warnings.some((message) => message.includes('Health degraded'))).toBe(true)
  })

  it('does not throw when a diagnostics reader fails during a heartbeat', async () => {
    await launch({ diagnosticsInterval: 60 })
    expect(diagnosticsHeartbeat).not.toBeNull()

    jest.spyOn(platform.client, 'getStatus').mockImplementation(() => {
      throw new Error('status unavailable')
    })

    expect(() => diagnosticsHeartbeat!()).not.toThrow()
  })
})
