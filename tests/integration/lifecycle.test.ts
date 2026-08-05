/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Startup, shutdown, and failure reporting.
 *
 * These are the paths that decide whether a plugin running unattended for
 * months in someone's house degrades visibly or silently, and whether asking
 * Homebridge to stop actually stops it. They are also the hardest to reproduce
 * in the field, which is why they are asserted here rather than left to the
 * happy-path suites to touch incidentally.
 */

jest.mock('../../src/utils/retry', () => {
  const actual = jest.requireActual<typeof import('../../src/utils/retry')>('../../src/utils/retry')
  return { ...actual, sleep: () => Promise.resolve() }
})

import nock from 'nock'
import { MyAlarmComPlatform } from '../../src/platform'
import {
  BASE_URL,
  KEEPALIVE_INTERVAL_MS,
  POLL_FAILURE_WARN_THRESHOLD,
} from '../../src/settings'
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

/** Long enough that the poll timer never fires unprompted in these tests. */
const POLL_INTERVAL_SEC = 3_600

const CONFIG: MyAlarmComPlatformConfig = {
  platform: 'MyAlarmCom',
  username: 'user@example.com',
  password: 'correct-horse-battery',
  twoFactorAuthenticationId: 'a'.repeat(64),
  useEventStream: false,
  pollIntervalSeconds: POLL_INTERVAL_SEC,
  // The quiet-until-it-repeats policy routes single failures to debug, which is
  // dropped entirely when this is off — so the policy is only observable here
  // with debug on.
  debug: true,
}

const LOGIN_PAGE_HTML = ['__VIEWSTATE', '__VIEWSTATEGENERATOR', '__EVENTVALIDATION', '__PREVIOUSPAGE']
  .map((name) => `<input type="hidden" name="${name}" value="${name}-value" />`)
  .join('\n')

const FRONT_DOOR = '1234567-1'

describe('platform lifecycle', () => {
  let api: FakeHomebridgeApi
  let log: RecordingLogging

  function interceptSignIn(): void {
    nock(BASE_URL).persist().get('/login').reply(200, LOGIN_PAGE_HTML)
    nock(BASE_URL).persist().post('/web/Default.aspx').reply(302, '', [
      'Set-Cookie', 'ASP.NET_SessionId=session-value; path=/; HttpOnly',
      'Set-Cookie', 'afg=csrf-value; path=/',
    ])
  }

  function interceptDiscovery(): void {
    nock(BASE_URL).persist().get('/web/api/identities').reply(200, identitiesFixture)
    nock(BASE_URL).persist().get('/web/api/systems/systems/7654321').reply(200, systemFixture)
    nock(BASE_URL).persist().get('/web/api/devices/partitions').query(true).reply(200, partitionsFixture)
    nock(BASE_URL).persist().get('/web/api/devices/sensors').query(true).reply(200, sensorsFixture)
  }

  /** Reinstate a working account after a test has replaced the interceptors. */
  function restoreAccount(): void {
    nock.cleanAll()
    interceptSignIn()
    interceptDiscovery()
  }

  async function launch(
    overrides: Partial<MyAlarmComPlatformConfig> = {},
  ): Promise<MyAlarmComPlatform> {
    const platform = new MyAlarmComPlatform(log, { ...CONFIG, ...overrides }, api.asApi())
    api.emit('didFinishLaunching')
    await waitFor(() => log.infoMessages.some((message) => message.includes('Ready')), {
      description: 'the platform to reach Ready',
    })
    return platform
  }

  /** How many refresh failures have been reported, at any level. */
  function failureCount(): number {
    return [...log.debugMessages, ...log.warnings, ...log.errors]
      .filter((message) => message.includes('Targeted refresh of'))
      .length
  }

  /**
   * Drive `count` refreshes that are expected to fail, one at a time.
   *
   * Strictly sequential, because `requestDeviceRefresh` coalesces: a second
   * request issued before the debounce window closes becomes part of the same
   * refresh, so a loop that does not wait produces fewer failures than it asked
   * for.
   */
  async function driveFailingRefreshes(platform: MyAlarmComPlatform, count: number): Promise<void> {
    for (let attempt = 1; attempt <= count; attempt++) {
      platform.requestDeviceRefresh(FRONT_DOOR)
      await waitFor(() => failureCount() >= attempt, {
        description: `refresh failure ${attempt} of ${count}`,
      })
    }
  }

  /** Drive one refresh that is expected to succeed. */
  async function driveSuccessfulRefresh(platform: MyAlarmComPlatform): Promise<void> {
    const failuresBefore = failureCount()
    const infoBefore = log.infoMessages.length

    platform.requestDeviceRefresh(FRONT_DOOR)

    await waitFor(() => log.infoMessages.length > infoBefore, {
      description: 'the refresh to report recovery',
    })
    expect(failureCount()).toBe(failuresBefore)
  }

  beforeEach(() => {
    nock.cleanAll()
    api = new FakeHomebridgeApi()
    log = createHomebridgeLogging()
    interceptSignIn()
    interceptDiscovery()
  })

  afterEach(() => {
    api.emit('shutdown')
    jest.restoreAllMocks()
    nock.cleanAll()
  })

  describe('shutdown', () => {
    it('clears the poll and keep-alive intervals it armed', async () => {
      const armed: unknown[] = []
      const realSetInterval = global.setInterval.bind(global)
      jest.spyOn(global, 'setInterval').mockImplementation(((
        handler: Parameters<typeof setInterval>[0],
        delay?: number,
      ) => {
        // Omit rest args: @types/node types them as `void | undefined`, so
        // spreading `unknown[]` fails typecheck under the locked 20.x types.
        const handle = realSetInterval(handler, delay)
        if (delay === POLL_INTERVAL_SEC * 1_000 || delay === KEEPALIVE_INTERVAL_MS) {
          armed.push(handle)
        }
        return handle
      }))
      const cleared = jest.spyOn(global, 'clearInterval')

      await launch()
      expect(armed).toHaveLength(2)

      api.emit('shutdown')

      for (const handle of armed) {
        expect(cleared).toHaveBeenCalledWith(handle)
      }
    })

    it('is idempotent, so a repeated shutdown reports nothing twice', async () => {
      await launch({ diagnosticsInterval: 60 })
      const infoBefore = log.infoMessages.length

      api.emit('shutdown')
      const afterFirst = log.infoMessages.length
      api.emit('shutdown')

      expect(afterFirst).toBeGreaterThan(infoBefore)
      expect(log.infoMessages.length).toBe(afterFirst)
    })

    /**
     * A HomeKit write or a stream frame delivered mid-teardown used to re-arm
     * the debounce timer that shutdown had just cleared, then run a network
     * refresh against a platform that was supposed to be gone.
     */
    it('refuses a device refresh requested after it', async () => {
      const platform = await launch()
      api.emit('shutdown')

      const armed = jest.spyOn(global, 'setTimeout')
      platform.requestDeviceRefresh(FRONT_DOOR)

      // Asserted as "no timer at all", not "no timer with this particular delay":
      // keying the negative assertion on the debounce constant would let a change
      // of delay pass while the behaviour under test went unverified.
      expect(armed).not.toHaveBeenCalled()
    })
  })

  describe('reporting a failure that will not clear', () => {
    /**
     * A 403, which Alarm.com hands out transiently. Not retried, so each refresh
     * costs the circuit breaker exactly one failure and it stays closed — which
     * keeps these tests about the escalation policy rather than the breaker.
     */
    function interceptForbiddenSensors(): void {
      nock.cleanAll()
      interceptSignIn()
      nock(BASE_URL).persist().get('/web/api/devices/sensors').query(true).reply(403, 'forbidden')
    }

    /** A 5xx, which *is* retried, so it opens the breaker within a few cycles. */
    function interceptUnavailableSensors(): void {
      nock.cleanAll()
      interceptSignIn()
      nock(BASE_URL).persist().get('/web/api/devices/sensors').query(true).reply(503, 'unavailable')
    }

    /**
     * Every retryable failure logs at debug, which is off by default. Without
     * escalation a sustained Alarm.com outage produced no output at all while
     * HomeKit silently went stale — the worst of both.
     */
    it('escalates to a warning once the same failure repeats', async () => {
      const platform = await launch()
      interceptForbiddenSensors()

      await driveFailingRefreshes(platform, POLL_FAILURE_WARN_THRESHOLD)

      expect(log.warnings.join('\n')).toMatch(/failed \d+ times in a row/)
      expect(log.warnings.join('\n')).toMatch(/HomeKit state may be stale/)
    })

    /**
     * The error type changes mid-outage: the first failures are 5xx, then the
     * circuit breaker opens and they become CircuitBreakerError. A counter
     * keyed on the message reset at exactly that point and never escalated.
     */
    it('keeps counting even as the breaker changes which error arrives', async () => {
      const platform = await launch()
      interceptUnavailableSensors()

      await driveFailingRefreshes(platform, POLL_FAILURE_WARN_THRESHOLD + 2)

      // The outage summary fires exactly once, and it fires despite the error type
      // changing under it when the breaker opens.
      expect(log.warnings.filter((message) => message.includes('times in a row'))).toHaveLength(1)
      expect(log.debugMessages.join('\n')).toMatch(/Circuit breaker|Alarm.com returned 503/)
      // Seven sequential refreshes, the first few retried three times each,
      // which is slower than the default per-test budget under coverage.
    }, 30_000)

    it('stays quiet about the first failure, which may be nothing', async () => {
      const platform = await launch()
      interceptForbiddenSensors()

      await driveFailingRefreshes(platform, 1)

      expect(log.warnings.join('\n')).not.toMatch(/times in a row/)
      expect(log.debugMessages.join('\n')).toMatch(/Targeted refresh of 1 device\(s\) failed/)
    })

    it('says so plainly when it starts working again', async () => {
      const platform = await launch()
      interceptForbiddenSensors()

      await driveFailingRefreshes(platform, POLL_FAILURE_WARN_THRESHOLD)
      expect(log.warnings.join('\n')).toMatch(/times in a row/)

      restoreAccount()
      await driveSuccessfulRefresh(platform)

      expect(log.infoMessages.join('\n')).toMatch(/reachable again/)
    })
  })

  describe('a device Alarm.com will not describe', () => {
    /**
     * Unregistering is not cosmetic: HomeKit loses the room, the name, and
     * every automation bound to that accessory. Inferring "gone" from "we could
     * not read it" made a partial response on first discovery delete devices
     * that were still on the account.
     */
    it('keeps its accessory rather than unregistering it', async () => {
      nock.cleanAll()
      interceptSignIn()
      nock(BASE_URL).persist().get('/web/api/identities').reply(200, identitiesFixture)
      nock(BASE_URL).persist().get('/web/api/systems/systems/7654321').reply(200, systemFixture)
      nock(BASE_URL).persist().get('/web/api/devices/partitions').query(true).reply(200, partitionsFixture)
      // Sensor detail comes back empty, as a truncated response would.
      nock(BASE_URL).persist().get('/web/api/devices/sensors').query(true).reply(200, { data: [] })

      await launch()

      expect(api.unregistered).toEqual([])
      expect(log.warnings.join('\n')).toMatch(/returned no detail for 5 device\(s\)/)
    })
  })

  describe('a sensor Alarm.com did not name', () => {
    it('publishes it under its device id rather than failing discovery', async () => {
      const namelessSensors = {
        data: sensorsFixture.data.map((sensor) => {
          const { description: _dropped, ...attributes } = sensor.attributes
          return { ...sensor, attributes }
        }),
      }
      nock.cleanAll()
      interceptSignIn()
      nock(BASE_URL).persist().get('/web/api/identities').reply(200, identitiesFixture)
      nock(BASE_URL).persist().get('/web/api/systems/systems/7654321').reply(200, systemFixture)
      nock(BASE_URL).persist().get('/web/api/devices/partitions').query(true).reply(200, partitionsFixture)
      nock(BASE_URL).persist().get('/web/api/devices/sensors').query(true).reply(200, namelessSensors)

      await launch()

      expect(api.registeredNames).toContain(`Sensor ${FRONT_DOOR}`)
    })
  })
})
