/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The signal store is written from a real discovery, against captured fixtures.
 * Paging is asserted from the SQLite rows, not from a mock of the writer.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as Sqlite from 'node:sqlite'
import nock from 'nock'
import {
  AlarmComSignals,
  ALARM_ACTIVE_SUMMARY,
  AUTH_LOGIN_FORM_SUMMARY,
  AUTH_REJECTED_SUMMARY,
  CLOUD_OFFLINE_SUMMARY,
  PAGERDUTY_STARTUP_LOG,
  SMOKE_ACTIVE_SUMMARY,
} from '../../src/alarmcom-signals'
import { MyAlarmComPlatform } from '../../src/platform'
import { BASE_URL, PLUGIN_NAME } from '../../src/settings'
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

const sqlite = typeof process.getBuiltinModule === 'function'
  ? process.getBuiltinModule('node:sqlite') as typeof Sqlite | undefined
  : undefined
const describeWithSqlite = sqlite ? describe : describe.skip

const LOGIN_PAGE_HTML = ['__VIEWSTATE', '__VIEWSTATEGENERATOR', '__EVENTVALIDATION', '__PREVIOUSPAGE']
  .map((name) => `<input type="hidden" name="${name}" value="${name}-value" />`)
  .join('\n')

const CONFIG: MyAlarmComPlatformConfig = {
  platform: 'MyAlarmCom',
  username: 'user@example.com',
  password: 'correct-horse-battery',
  twoFactorAuthenticationId: 'a'.repeat(64),
  useEventStream: false,
  pollIntervalSeconds: 3600,
  pagerdutySignals: true,
}

const UPSTAIRS_SMOKE = '1234567-20'
const FRONT_DOOR = '1234567-1'

interface SignalRow {
  plugin: string
  signal: string
  active: number
  severity: string
  summary: string
}

interface SensorResource {
  id: string
  attributes: Record<string, unknown>
}

function replyWithRequested(resources: { id: string }[]) {
  return (request: Request): { data: { id: string }[] } => {
    const requested = new URL(request.url).searchParams.getAll('ids[]')
    return { data: resources.filter((resource) => requested.includes(resource.id)) }
  }
}

function sensorsWith(id: string, attributes: Record<string, unknown>): { data: SensorResource[] } {
  return {
    data: sensorsFixture.data.map((sensor) => (
      sensor.id === id
        ? { ...sensor, attributes: { ...sensor.attributes, ...attributes } }
        : sensor
    )),
  }
}

function partitionsInAlarm(): typeof partitionsFixture {
  return {
    ...partitionsFixture,
    data: partitionsFixture.data.map((partition) => ({
      ...partition,
      attributes: { ...partition.attributes, hasActiveAlarm: true },
    })),
  }
}

describeWithSqlite('PagerDuty signals from a live discovery', () => {
  let api: FakeHomebridgeApi
  let log: RecordingLogging
  let storagePath: string

  const storeDir = (): string => join(storagePath, 'homebridge-pagerduty')

  const readRows = (): SignalRow[] => {
    const db = new sqlite!.DatabaseSync(join(storeDir(), 'signals-2026-10-24', 'signals.sqlite'))
    try {
      return db.prepare(
        'SELECT plugin, signal, active, severity, summary FROM signals ORDER BY signal',
      ).all() as unknown as SignalRow[]
    } finally {
      db.close()
    }
  }

  const row = (signal: string): SignalRow | undefined => readRows().find((entry) => entry.signal === signal)

  function interceptSignIn(): void {
    nock(BASE_URL).get('/login').reply(200, LOGIN_PAGE_HTML)
    nock(BASE_URL).post('/web/Default.aspx').reply(302, '', [
      'Set-Cookie', 'ASP.NET_SessionId=session-value; path=/; HttpOnly',
      'Set-Cookie', 'afg=csrf-value; path=/',
    ])
  }

  function interceptAccount(
    partitions: typeof partitionsFixture = partitionsFixture,
    sensors: { data: SensorResource[] } = sensorsFixture,
  ): void {
    nock(BASE_URL).get('/web/api/identities').reply(200, identitiesFixture)
    nock(BASE_URL).get('/web/api/systems/systems/7654321').reply(200, systemFixture)
    nock(BASE_URL).get('/web/api/devices/partitions').query(true).reply(200, replyWithRequested(partitions.data))
    nock(BASE_URL).get('/web/api/devices/sensors').query(true).reply(200, replyWithRequested(sensors.data))
  }

  async function waitForStartup(): Promise<void> {
    await waitFor(
      () => log.infoMessages.some((message) => message.includes('Ready'))
        || log.errors.some((message) => message.includes('will not be retried')),
      { description: 'startup to finish' },
    )
  }

  async function launch(overrides: Partial<MyAlarmComPlatformConfig> = {}): Promise<MyAlarmComPlatform> {
    const platform = new MyAlarmComPlatform(log, { ...CONFIG, ...overrides }, api.asApi())
    api.emit('didFinishLaunching')
    await waitForStartup()
    return platform
  }

  beforeEach(() => {
    nock.cleanAll()
    api = new FakeHomebridgeApi()
    log = createHomebridgeLogging()
    storagePath = mkdtempSync(join(tmpdir(), 'myalarmcom-pagerduty-'))
    api.storageDirectory = storagePath
  })

  afterEach(() => {
    api.emit('shutdown')
    nock.cleanAll()
    rmSync(storagePath, { recursive: true, force: true })
  })

  it('creates nothing and does not log when the setting is off', async () => {
    interceptSignIn()
    interceptAccount()

    await launch({ pagerdutySignals: false })

    expect(existsSync(storeDir())).toBe(false)
    expect(log.infoMessages.some((message) => message.includes('homebridge-pagerduty support is enabled'))).toBe(false)
  })

  it('writes every signal clear at startup, including while a door is open', async () => {
    interceptSignIn()
    interceptAccount(partitionsFixture, sensorsWith(UPSTAIRS_SMOKE, { isMonitoringEnabled: true }))

    await launch()

    expect(log.infoMessages[0]).toBe(PAGERDUTY_STARTUP_LOG)
    expect(log.infoMessages.filter((message) => message === PAGERDUTY_STARTUP_LOG)).toHaveLength(1)
    expect(readRows()).toEqual([
      {
        plugin: PLUGIN_NAME,
        signal: 'alarm-active',
        active: 0,
        severity: 'critical',
        summary: ALARM_ACTIVE_SUMMARY,
      },
      {
        plugin: PLUGIN_NAME,
        signal: 'auth-failed',
        active: 0,
        severity: 'error',
        summary: AUTH_REJECTED_SUMMARY,
      },
      {
        plugin: PLUGIN_NAME,
        signal: 'cloud-offline',
        active: 0,
        severity: 'error',
        summary: CLOUD_OFFLINE_SUMMARY,
      },
      {
        plugin: PLUGIN_NAME,
        signal: 'smoke-active',
        active: 0,
        severity: 'critical',
        summary: SMOKE_ACTIVE_SUMMARY,
      },
    ])
  })

  it('pages an alarm and a tripped smoke detector together', async () => {
    interceptSignIn()
    interceptAccount(
      partitionsInAlarm(),
      sensorsWith(UPSTAIRS_SMOKE, { isMonitoringEnabled: true, state: 4, openClosedStatus: 3 }),
    )

    await launch()

    expect(row('alarm-active')).toMatchObject({ active: 1, severity: 'critical', summary: ALARM_ACTIVE_SUMMARY })
    expect(row('smoke-active')).toMatchObject({ active: 1, severity: 'critical', summary: SMOKE_ACTIVE_SUMMARY })
  })

  it('does not page a tripped smoke detector this plugin is not publishing', async () => {
    interceptSignIn()
    interceptAccount(
      partitionsFixture,
      sensorsWith(UPSTAIRS_SMOKE, { isMonitoringEnabled: false, state: 4, openClosedStatus: 3 }),
    )

    await launch()

    expect(api.registeredNames).not.toContain('Upstairs Smoke')
    expect(row('smoke-active')).toMatchObject({ active: 0 })
    expect(row('alarm-active')).toMatchObject({ active: 0 })
  })

  it('logs support once, then pages a rejected sign-in without clearing alarm or smoke', async () => {
    nock(BASE_URL).get('/login').reply(200, LOGIN_PAGE_HTML)
    nock(BASE_URL).post('/web/Default.aspx').reply(200, LOGIN_PAGE_HTML)

    await launch()

    expect(log.infoMessages).toEqual([PAGERDUTY_STARTUP_LOG])
    expect(row('auth-failed')).toEqual({
      plugin: PLUGIN_NAME,
      signal: 'auth-failed',
      active: 1,
      severity: 'error',
      summary: AUTH_REJECTED_SUMMARY,
    })
    expect(row('cloud-offline')).toMatchObject({ active: 0, summary: CLOUD_OFFLINE_SUMMARY })
    expect(row('alarm-active')).toBeUndefined()
    expect(row('smoke-active')).toBeUndefined()
  })

  it('uses the update sentence when the sign-in page cannot be read', async () => {
    nock(BASE_URL).get('/login').reply(200, '<html></html>')

    await launch()

    expect(row('auth-failed')).toMatchObject({
      active: 1,
      summary: AUTH_LOGIN_FORM_SUMMARY,
    })
    expect(row('alarm-active')).toBeUndefined()
  })

  it('logs the startup line once when discovery is retried', async () => {
    interceptSignIn()
    nock(BASE_URL).get('/web/api/identities').times(3).reply(500, 'unavailable')
    interceptAccount()

    await launch()

    expect(log.infoMessages.filter((message) => message === PAGERDUTY_STARTUP_LOG)).toHaveLength(1)
    expect(log.infoMessages[0]).toBe(PAGERDUTY_STARTUP_LOG)
    expect(log.infoMessages.some((message) => message.includes('Ready'))).toBe(true)
    expect(row('cloud-offline')).toMatchObject({ active: 0 })
    expect(row('auth-failed')).toMatchObject({ active: 0 })
  })

  it('does not page a 403, and leaves an active alarm in the store across shutdown', async () => {
    const unreachable = jest.spyOn(AlarmComSignals.prototype, 'noteUnreachable')
    const close = jest.spyOn(AlarmComSignals.prototype, 'close')
    interceptSignIn()
    interceptAccount(partitionsInAlarm())

    const platform = await launch()
    expect(row('alarm-active')).toMatchObject({ active: 1 })
    const unreachableBefore = unreachable.mock.calls.length

    nock.cleanAll()
    nock(BASE_URL).get('/web/api/devices/sensors').query(true).reply(403, 'forbidden')
    platform.requestDeviceRefresh(FRONT_DOOR)
    await waitFor(
      () => unreachable.mock.calls.length > unreachableBefore,
      { description: 'the refresh to fail' },
    )

    expect(row('cloud-offline')).toMatchObject({ active: 0 })
    expect(row('auth-failed')).toMatchObject({ active: 0 })
    expect(row('alarm-active')).toMatchObject({ active: 1 })

    api.emit('shutdown')
    api.emit('shutdown')

    expect(close).toHaveBeenCalledTimes(1)
    expect(row('alarm-active')).toMatchObject({ active: 1 })
  })
})
