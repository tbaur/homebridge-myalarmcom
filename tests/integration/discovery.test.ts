/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Discovery end to end: a real sign-in exchange over nock, the real client,
 * the real accessory classes, and real HAP services behind a Homebridge API
 * double. The only thing stubbed out is the pacing delay, which has its own
 * tests and would otherwise add a second of latency per request.
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
}

const LOGIN_PAGE_HTML = ['__VIEWSTATE', '__VIEWSTATEGENERATOR', '__EVENTVALIDATION', '__PREVIOUSPAGE']
  .map((name) => `<input type="hidden" name="${name}" value="${name}-value" />`)
  .join('\n')

/** The unsupported glass break sensor is only reachable if the system lists it. */
const SYSTEM_WITH_EVERY_SENSOR = {
  data: {
    ...systemFixture.data,
    relationships: {
      ...systemFixture.data.relationships,
      sensors: {
        data: [
          ...systemFixture.data.relationships.sensors.data,
          { id: '1234567-99', type: 'devices/sensor' },
        ],
      },
    },
  },
}

function interceptSignIn(): void {
  nock(BASE_URL).get('/login').reply(200, LOGIN_PAGE_HTML)
  nock(BASE_URL).post('/web/Default.aspx').reply(302, '', [
    'Set-Cookie', 'ASP.NET_SessionId=session-value; path=/; HttpOnly',
    'Set-Cookie', 'afg=csrf-value; path=/',
  ])
}

/** Answer a batched read with only the resources that were asked for. */
function replyWithRequested(resources: { id: string }[]) {
  return (uri: string): { data: { id: string }[] } => {
    const requested = new URL(uri, BASE_URL).searchParams.getAll('ids[]')
    return { data: resources.filter((resource) => requested.includes(resource.id)) }
  }
}

function interceptDiscovery(): void {
  nock(BASE_URL).get('/web/api/identities').reply(200, identitiesFixture)
  nock(BASE_URL).get('/web/api/systems/systems/7654321').reply(200, SYSTEM_WITH_EVERY_SENSOR)
  nock(BASE_URL)
    .get('/web/api/devices/partitions')
    .query(true)
    .reply(200, replyWithRequested(partitionsFixture.data))
  nock(BASE_URL)
    .get('/web/api/devices/sensors')
    .query(true)
    .reply(200, replyWithRequested(sensorsFixture.data))
}

describe('discovering an Alarm.com account', () => {
  let api: FakeHomebridgeApi
  let log: RecordingLogging

  /**
   * Homebridge starts discovery from a fire-and-forget lifecycle handler, so
   * the only signal a test has is the platform's own: "Ready" once discovery
   * has succeeded, and a failure is reported instead.
   */
  async function waitForDiscovery(): Promise<void> {
    await waitFor(
      () => log.infoMessages.some((message) => message.includes('Ready'))
        || log.errors.length > 0,
      { description: 'discovery to finish' },
    )
  }

  async function launch(overrides: Partial<MyAlarmComPlatformConfig> = {}): Promise<void> {
    new MyAlarmComPlatform(log, { ...CONFIG, ...overrides }, api.asApi())
    api.emit('didFinishLaunching')
    await waitForDiscovery()
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
  })

  it('publishes the panel and every supported, monitored sensor', async () => {
    await launch()

    expect(api.registeredNames).toEqual([
      'Home',
      'Front Door',
      'Kitchen Window',
      'Hallway Motion',
      'Basement Motion',
    ])
    expect(log.infoMessages.some((message) => message.includes('Discovered '))).toBe(true)
  })

  it('skips a device type it does not support yet', async () => {
    await launch()

    expect(api.registeredNames).not.toContain('Glass Break')
  })

  it('skips a sensor Alarm.com is not monitoring', async () => {
    await launch()

    expect(api.registeredNames).not.toContain('Upstairs Smoke')
  })

  it('publishes an unmonitored sensor when the user asks for it', async () => {
    await launch({ includeUnmonitoredSensors: true })

    expect(api.registeredNames).toContain('Upstairs Smoke')
    expect(api.registered).toHaveLength(6)
  })

  it('leaves out any device the user chose to ignore', async () => {
    await launch({ ignoredDeviceIds: ['1234567-1', '1234567-127'] })

    expect(api.registeredNames).toEqual(['Kitchen Window', 'Hallway Motion', 'Basement Motion'])
  })

  it('gives each accessory a stable identity and the standard information service', async () => {
    await launch()
    const frontDoor = api.registered.find((accessory) => accessory.displayName === 'Front Door')

    expect(frontDoor?.context).toMatchObject({
      deviceId: '1234567-1',
      kind: 'contact',
      displayName: 'Front Door',
    })
    expect(frontDoor?.UUID).toBe(api.hap.uuid.generate('myalarmcom-1234567-1'))
    expect(frontDoor?.services.some((service) => service.displayName === 'Alarm.com')).toBe(false)
  })

  it('pushes the discovered state onto the published services', async () => {
    await launch()
    const kitchenWindow = api.registered.find((accessory) => accessory.displayName === 'Kitchen Window')
    const contactState = kitchenWindow?.services
      .flatMap((service) => service.characteristics)
      .find((characteristic) => characteristic.UUID === api.hap.Characteristic.ContactSensorState.UUID)

    expect(contactState?.value).toBe(api.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED)
  })

  it('warns that the read-only account cannot arm the panel', async () => {
    await launch()

    expect(log.warnings.join('\n')).toMatch(/account used cannot change the arming state of "Home"/)
  })

  it('adopts an accessory Homebridge restored from its cache instead of adding it again', async () => {
    const platform = new MyAlarmComPlatform(log, CONFIG, api.asApi())
    const cached = new api.platformAccessory('Front Door', api.hap.uuid.generate('myalarmcom-1234567-1'))
    cached.context = { deviceId: '1234567-1', kind: 'contact', displayName: 'Front Door' }
    platform.configureAccessory(cached as never)

    api.emit('didFinishLaunching')
    await waitForDiscovery()

    expect(api.registeredNames).not.toContain('Front Door')
    expect(api.updated).toContain(cached)
  })

  it('unregisters an accessory for a device that is no longer on the account', async () => {
    const platform = new MyAlarmComPlatform(log, CONFIG, api.asApi())
    const stale = new api.platformAccessory('Old Garage Door', api.hap.uuid.generate('myalarmcom-1234567-3'))
    stale.context = { deviceId: '1234567-3', kind: 'contact', displayName: 'Old Garage Door' }
    platform.configureAccessory(stale as never)

    api.emit('didFinishLaunching')
    // Wait for Ready, not only unregister: stale removal runs mid-discovery, and
    // returning early left getPartitions/getSensors in flight to steal the next
    // test's nock interceptors (flake: next test timed out on discovery).
    await waitForDiscovery()

    expect(api.unregistered).toContain(stale)
  })

  it('unregisters a cached accessory that is now ignored in config', async () => {
    const platform = new MyAlarmComPlatform(log, {
      ...CONFIG,
      ignoredDeviceIds: ['1234567-1'],
    }, api.asApi())
    const ignored = new api.platformAccessory('Front Door', api.hap.uuid.generate('myalarmcom-1234567-1'))
    ignored.context = { deviceId: '1234567-1', kind: 'contact', displayName: 'Front Door' }
    platform.configureAccessory(ignored as never)

    api.emit('didFinishLaunching')
    // Wait for Ready so #start finishes before afterEach shutdown; otherwise the
    // in-flight discovery races the next test's nock interceptors.
    await waitForDiscovery()

    expect(api.unregistered).toContain(ignored)
    expect(api.registeredNames).not.toContain('Front Door')
  })

  it('reports a sign-in failure without publishing anything', async () => {
    nock.cleanAll()
    nock(BASE_URL).get('/login').reply(200, LOGIN_PAGE_HTML)
    nock(BASE_URL).post('/web/Default.aspx').reply(200, LOGIN_PAGE_HTML)

    new MyAlarmComPlatform(log, CONFIG, api.asApi())
    api.emit('didFinishLaunching')
    await waitFor(() => log.errors.length > 0, { description: 'the failure to be reported' })

    expect(api.registered).toEqual([])
    expect(log.errors.join('\n')).toMatch(/Initial discovery failed/)
  })

  it('retries initial discovery after a transient failure and still reaches Ready', async () => {
    nock.cleanAll()
    interceptSignIn()
    // Exhaust the client's per-request retries, then succeed on the platform retry.
    nock(BASE_URL).get('/web/api/identities').times(3).reply(503, 'unavailable')
    interceptDiscovery()

    await launch()

    expect(log.warnings.join('\n')).toMatch(/Initial discovery failed:.*Retrying/)
    expect(log.infoMessages.some((message) => message.includes('Ready'))).toBe(true)
    expect(api.registered.length).toBeGreaterThan(0)
  })

  /**
   * Homebridge does not guard a platform constructor: a throw escapes
   * `loadPlatforms()`, rejects `Server.start()`, and SIGTERMs the process. One
   * typo in this plugin's block used to take down every other plugin and every
   * accessory in the house, leaving a raw stack trace as the only explanation.
   */
  describe('when the configuration is unusable', () => {
    function launchWithoutCredentials(): MyAlarmComPlatform {
      const platform = new MyAlarmComPlatform(log, { platform: 'MyAlarmCom' }, api.asApi())
      api.emit('didFinishLaunching')
      return platform
    }

    it('reports what to fix instead of taking the bridge down', () => {
      expect(launchWithoutCredentials).not.toThrow()

      expect(log.errors.join('\n')).toMatch(/"username" is required/)
      expect(log.errors.join('\n')).toMatch(/"password" is required/)
      expect(log.errors.join('\n')).toMatch(/rest of your bridge is unaffected/)
    })

    it('publishes nothing and signs in to nothing', async () => {
      launchWithoutCredentials()
      await Promise.resolve()

      expect(api.registered).toEqual([])
      expect(log.infoMessages.join('\n')).not.toMatch(/Ready/)
      // Every interceptor is still unused: no login was even attempted.
      expect(nock.pendingMocks().length).toBeGreaterThan(0)
    })

    it('refuses a device refresh rather than reaching for a client it has none of', () => {
      const platform = launchWithoutCredentials()

      expect(() => platform.client).toThrow(/no usable configuration/)
      expect(() => platform.requestDeviceRefresh('1234567-1')).not.toThrow()
    })
  })

  it('passes the configuration warnings on to the user', () => {
    new MyAlarmComPlatform(log, { ...CONFIG, pollIntervalSeconds: 5 }, api.asApi())

    expect(log.warnings.join('\n')).toMatch(/"pollIntervalSeconds" was raised from 5 to 60 seconds/)
  })
})
