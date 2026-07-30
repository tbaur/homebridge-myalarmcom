/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Periodic re-enumeration of the account, which is what notices a sensor being
 * added or removed at the panel. Polling on its own only refreshes devices
 * already known, so without this a deleted device keeps its HomeKit tile until
 * Homebridge restarts.
 *
 * Rediscovery is due on elapsed wall-clock time. Rather than fake the clock,
 * which deadlocks the rate limiter, this suite shortens the interval to less
 * than a second and lets real time pass. It lives apart from the other
 * integration tests because that shortened interval would make rediscovery due
 * during theirs.
 */

const SHORT_REDISCOVERY_MS = 800

jest.mock('../../src/settings', () => ({
  ...jest.requireActual<typeof import('../../src/settings')>('../../src/settings'),
  REDISCOVERY_INTERVAL_MS: SHORT_REDISCOVERY_MS,
}))

jest.mock('../../src/utils/retry', () => {
  const actual = jest.requireActual<typeof import('../../src/utils/retry')>('../../src/utils/retry')
  return { ...actual, sleep: () => Promise.resolve() }
})

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

const CONFIG: MyAlarmComPlatformConfig = {
  platform: 'MyAlarmCom',
  username: 'user@example.com',
  password: 'correct-horse-battery',
  twoFactorAuthenticationId: 'a'.repeat(64),
  useEventStream: false,
}

const LOGIN_PAGE_HTML = ['__VIEWSTATE', '__VIEWSTATEGENERATOR', '__EVENTVALIDATION', '__PREVIOUSPAGE']
  .map((name) => `<input type="hidden" name="${name}" value="${name}-value" />`)
  .join('\n')

const FRONT_DOOR = '1234567-1'
const SYSTEM_PATH = '/web/api/systems/systems/7654321'

/** The account with one sensor deleted at the panel. */
const SYSTEM_WITHOUT_FRONT_DOOR = {
  data: {
    ...systemFixture.data,
    relationships: {
      ...systemFixture.data.relationships,
      sensors: {
        data: systemFixture.data.relationships.sensors.data.filter((s) => s.id !== FRONT_DOOR),
      },
    },
  },
}

describe('re-enumerating the account while running', () => {
  let api: FakeHomebridgeApi
  let log: RecordingLogging
  let sensorReads: string[][]
  /** Per-id attribute overrides applied by the persistent sensor interceptor. */
  let sensorAttributeOverrides: Record<string, Record<string, unknown>>

  function requestedIds(uri: string): string[] {
    return new URL(uri, BASE_URL).searchParams.getAll('ids[]')
  }

  function interceptSignInAndDevices(): void {
    nock(BASE_URL).get('/login').reply(200, LOGIN_PAGE_HTML)
    nock(BASE_URL).post('/web/Default.aspx').reply(302, '', [
      'Set-Cookie', 'ASP.NET_SessionId=session-value; path=/; HttpOnly',
      'Set-Cookie', 'afg=csrf-value; path=/',
    ])
    nock(BASE_URL).get('/web/api/identities').reply(200, identitiesFixture)

    nock(BASE_URL)
      .persist()
      .get('/web/api/devices/partitions')
      .query(true)
      .reply(200, (uri: string) => ({
        data: partitionsFixture.data.filter((p) => requestedIds(uri).includes(p.id)),
      }))

    nock(BASE_URL)
      .persist()
      .get('/web/api/devices/sensors')
      .query(true)
      .reply(200, (uri: string) => {
        const ids = requestedIds(uri)
        sensorReads.push(ids)
        return {
          data: sensorsFixture.data
            .filter((sensor) => ids.includes(sensor.id))
            .map((sensor) => {
              const overrides = sensorAttributeOverrides[sensor.id]
              if (!overrides) {
                return sensor
              }
              return {
                ...sensor,
                attributes: {
                  ...sensor.attributes,
                  ...overrides,
                },
              }
            }),
        }
      })
  }

  async function launch(overrides: Partial<MyAlarmComPlatformConfig> = {}): Promise<void> {
    // Installed before the platform starts, so the poll interval it schedules
    // is the faked one. Everything else, the clock included, stays real.
    jest.useFakeTimers({
      doNotFake: [
        'setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate',
        'nextTick', 'queueMicrotask', 'Date', 'performance',
      ],
    })

    new MyAlarmComPlatform(log, { ...CONFIG, ...overrides }, api.asApi())
    api.emit('didFinishLaunching')
    await waitFor(
      () => log.infoMessages.some((message) => message.includes('Ready')),
      { description: 'discovery to finish' },
    )
  }

  /**
   * Let the shortened rediscovery interval elapse in real time.
   *
   * Real time, not a faked clock: the rate limiter paces requests by comparing
   * `Date.now()` against its last request, so freezing the clock leaves it
   * waiting for an interval that can never pass.
   */
  async function waitOutRediscoveryInterval(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, SHORT_REDISCOVERY_MS + 100))
  }

  /** Fire one poll the way the interval timer would. */
  function poll(): void {
    jest.advanceTimersByTime(60_000)
  }

  beforeEach(() => {
    api = new FakeHomebridgeApi()
    log = createHomebridgeLogging()
    sensorReads = []
    sensorAttributeOverrides = {}
    interceptSignInAndDevices()
    nock(BASE_URL).get(SYSTEM_PATH).reply(200, systemFixture)
  })

  afterEach(() => {
    jest.useRealTimers()
    api.emit('shutdown')
  })

  it('unregisters a device that has been removed from the account', async () => {
    await launch()
    expect(api.registeredNames).toContain('Front Door')

    // The system id is cached, so only the device list is fetched again.
    nock(BASE_URL).get(SYSTEM_PATH).reply(200, SYSTEM_WITHOUT_FRONT_DOOR)
    await waitOutRediscoveryInterval()
    poll()

    await waitFor(() => api.unregistered.length > 0, { description: 'the device to be dropped' })
    expect(api.unregistered.map((accessory) => accessory.displayName)).toEqual(['Front Door'])
  })

  it('stops polling a device it has dropped', async () => {
    await launch()
    nock(BASE_URL).get(SYSTEM_PATH).reply(200, SYSTEM_WITHOUT_FRONT_DOOR)
    await waitOutRediscoveryInterval()
    poll()
    await waitFor(() => api.unregistered.length > 0, { description: 'the device to be dropped' })

    // Further polls may also be rediscoveries (short interval + waitFor latency);
    // keep the reduced system list available so they do not hang on a missing nock.
    nock(BASE_URL).persist().get(SYSTEM_PATH).reply(200, SYSTEM_WITHOUT_FRONT_DOOR)

    sensorReads.length = 0
    poll()
    await waitFor(() => sensorReads.length > 0, { description: 'the next ordinary poll' })

    expect(sensorReads[0]).not.toContain(FRONT_DOOR)
  })

  it('keeps the devices the account still reports', async () => {
    await launch()
    nock(BASE_URL).get(SYSTEM_PATH).reply(200, systemFixture)
    sensorReads.length = 0

    await waitOutRediscoveryInterval()
    poll()
    await waitFor(() => sensorReads.length > 0, { description: 'the rediscovery to read sensors' })

    expect(api.unregistered).toEqual([])
    expect(api.registeredNames).toContain('Front Door')
  })

  it('logs periodic rediscovery at debug, not info', async () => {
    // Scoped debug is dropped unless config.debug is on.
    await launch({ debug: true })
    expect(log.infoMessages.some((message) => message.startsWith('Discovered '))).toBe(true)

    const infoBefore = log.infoMessages.length
    nock(BASE_URL).get(SYSTEM_PATH).reply(200, systemFixture)
    await waitOutRediscoveryInterval()
    poll()
    await waitFor(
      () => log.debugMessages.some((message) => message.includes('Rediscovering devices')),
      { description: 'the rediscovery debug line' },
    )

    expect(
      log.debugMessages.some((message) =>
        message.includes('Rediscovering devices to detect panel add/remove changes'),
      ),
    ).toBe(true)
    expect(
      log.infoMessages.slice(infoBefore).some((message) => message.startsWith('Discovered ')),
    ).toBe(false)
  })

  it('unregisters a sensor that becomes unmonitored on rediscovery', async () => {
    await launch()
    expect(api.registeredNames).toContain('Front Door')

    sensorAttributeOverrides[FRONT_DOOR] = { isMonitoringEnabled: false }
    nock(BASE_URL).get(SYSTEM_PATH).reply(200, systemFixture)

    await waitOutRediscoveryInterval()
    poll()

    await waitFor(() => api.unregistered.length > 0, { description: 'the unmonitored sensor to be dropped' })
    expect(api.unregistered.map((accessory) => accessory.displayName)).toEqual(['Front Door'])
    expect(log.infoMessages.join('\n')).toMatch(/monitoring is disabled/)
  })

  /**
   * Regression. The due-time was stamped only when rediscovery succeeded, so a
   * failing one stayed due and ran again on every single poll instead of once
   * an interval. Alarm.com locks accounts for exactly that traffic pattern, and
   * it displaced the ordinary refresh too, so HomeKit went stale as well.
   */
  it('does not re-enumerate on every poll after a rediscovery fails', async () => {
    await launch()

    // One refusal, and nothing offered after it: a second enumeration would
    // find no interceptor and be reported as a second failure.
    nock(BASE_URL).get(SYSTEM_PATH).reply(403, '{"errors":["Forbidden"]}')
    await waitOutRediscoveryInterval()
    poll()
    await waitFor(() => log.errors.some((error) => error.includes('Rediscovery failed')), {
      description: 'the failed rediscovery to be reported',
    })

    // The next poll comes before the interval is up, so it is an ordinary
    // refresh rather than another enumeration.
    sensorReads.length = 0
    poll()
    await waitFor(() => sensorReads.length > 0, { description: 'the ordinary poll to run' })

    expect(log.errors.filter((error) => error.includes('Rediscovery failed'))).toHaveLength(1)
    expect(sensorReads[0]).toContain(FRONT_DOOR)
  })
})
