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
import { CircuitState } from '../../src/api/circuit-breaker'
import { KEEPALIVE_INTERVAL_MS } from '../../src/settings'

jest.mock('../../src/utils/retry', () => {
  const actual = jest.requireActual<typeof import('../../src/utils/retry')>('../../src/utils/retry')
  return { ...actual, sleep: () => Promise.resolve() }
})

/** Heartbeat cadence used throughout, deliberately unlike any other interval. */
const DIAGNOSTICS_INTERVAL_SEC = 45
const DIAGNOSTICS_INTERVAL_MS = DIAGNOSTICS_INTERVAL_SEC * 1_000

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
      () => log.infoMessages.some((message) => message.includes('Ready'))
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

    // The heartbeat is picked out by its interval, which is why CONFIG sets the
    // poll and auth intervals far away from it. Asserted rather than assumed:
    // a constant that drifted into collision would otherwise capture the wrong
    // handler and leave four tests failing on a confusing null dereference.
    expect(DIAGNOSTICS_INTERVAL_MS).not.toBe(KEEPALIVE_INTERVAL_MS)
    expect(DIAGNOSTICS_INTERVAL_MS).not.toBe(Number(CONFIG.pollIntervalSeconds) * 1_000)

    const realSetInterval = global.setInterval.bind(global)
    setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation((handler, timeout) => {
      if (timeout === DIAGNOSTICS_INTERVAL_MS && typeof handler === 'function') {
        diagnosticsHeartbeat = handler
      }
      return realSetInterval(handler, timeout as number)
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
    await launch({ diagnosticsInterval: DIAGNOSTICS_INTERVAL_SEC })

    const startLine = log.infoMessages.find((message) => message.includes('Diagnostics start'))
    expect(startLine).toBeDefined()
    // Homebridge appends extra log args as JSON; the human line must stand alone.
    expect(startLine).not.toContain('"msg"')
    expect(startLine).not.toContain('"devices"')
    expect(diagnosticsHeartbeat).not.toBeNull()

    const infoBefore = log.infoMessages.length
    diagnosticsHeartbeat!()
    const healthLine = log.infoMessages.slice(infoBefore).find((message) => message.includes('Health:'))
    expect(healthLine).toBeDefined()
    expect(healthLine).not.toContain('"msg"')

    const afterFirst = log.infoMessages.length
    diagnosticsHeartbeat!()
    expect(
      log.infoMessages.slice(afterFirst).filter((message) => message.includes('Health:')).length,
    ).toBe(1)
  })

  it('emits a stop snapshot on shutdown', async () => {
    await launch({ diagnosticsInterval: DIAGNOSTICS_INTERVAL_SEC })
    log.infoMessages.length = 0

    api.emit('shutdown')

    expect(log.infoMessages.some((message) => message.includes('Diagnostics stop'))).toBe(true)
  })

  it('emits Diagnostics stop only once when shutdown is signaled twice', async () => {
    await launch({ diagnosticsInterval: DIAGNOSTICS_INTERVAL_SEC })
    log.infoMessages.length = 0

    api.emit('shutdown')
    api.emit('shutdown')

    expect(log.infoMessages.filter((message) => message.includes('Diagnostics stop'))).toHaveLength(1)
  })

  it('logs a degraded transition when the circuit breaker opens', async () => {
    await launch({ diagnosticsInterval: DIAGNOSTICS_INTERVAL_SEC })
    expect(diagnosticsHeartbeat).not.toBeNull()

    jest.spyOn(platform.client, 'getStatus').mockReturnValue({
      circuitBreaker: { state: CircuitState.OPEN },
      rateLimiter: { remaining: 100 },
      hasSession: true,
    })

    log.warnings.length = 0
    diagnosticsHeartbeat!()

    expect(log.warnings.some((message) => message.includes('Health degraded'))).toBe(true)
  })

  it('does not throw when a diagnostics reader fails during a heartbeat', async () => {
    await launch({ diagnosticsInterval: DIAGNOSTICS_INTERVAL_SEC })
    expect(diagnosticsHeartbeat).not.toBeNull()

    jest.spyOn(platform.client, 'getStatus').mockImplementation(() => {
      throw new Error('status unavailable')
    })

    expect(() => diagnosticsHeartbeat!()).not.toThrow()
  })
})
