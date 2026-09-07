/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The write path, end to end: a HomeKit tile moving, through the accessory and
 * the real client, to an HTTP request on the wire and back to a characteristic.
 *
 * This is the seam every other test misses. The unit tests hand the accessory a
 * mocked client, so nothing there can see what the real one actually puts on
 * the wire — which is exactly where issue #65 lived, labelling command bodies
 * `application/vnd.api+json` and collecting an HTTP 500 for every arm while
 * reads carried on working. The other integration suites cover discovery,
 * rediscovery, live updates and lifecycle, all of them read paths.
 *
 * So the requests here are matched on method, URL, content type and body. A
 * regression in any of those fails as "no interceptor" rather than passing
 * against a double that was told to expect the wrong thing.
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
import { fixtureAt } from '../helpers/fixtures'

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

const PARTITION_ID = '1234567-127'
const COMMAND_CONTENT_TYPE = 'application/json; charset=UTF-8'

const basePartition = fixtureAt(partitionsFixture.data, 0, 'partitions')

/** The fixture partition is read-only; arming needs one the account may control. */
function partitionInState(state: number): Record<string, unknown> {
  return {
    ...basePartition,
    attributes: {
      ...basePartition.attributes,
      hasPermissionToChangeState: true,
      state,
      desiredState: state,
    },
  }
}

/**
 * The sensor fixture holds an open Kitchen Window, which now refuses an arm
 * before it is sent. Most tests here are about what goes on the wire, so they
 * need a house that is shut; the refusal gets a test of its own.
 */
function shutSensors(): Record<string, unknown>[] {
  return sensorsFixture.data.map((sensor) => ({
    ...sensor,
    attributes: { ...sensor.attributes, state: 1, openClosedStatus: 2 },
  }))
}

describe('arming from HomeKit, over real HTTP', () => {
  let api: FakeHomebridgeApi
  let log: RecordingLogging

  function requestedIds(uri: string): string[] {
    return new URL(uri, BASE_URL).searchParams.getAll('ids[]')
  }

  function interceptSignInAndDiscovery(sensors = shutSensors()): void {
    nock(BASE_URL).get('/login').reply(200, LOGIN_PAGE_HTML)
    nock(BASE_URL).post('/web/Default.aspx').reply(302, '', [
      'Set-Cookie', 'ASP.NET_SessionId=session-value; path=/; HttpOnly',
      'Set-Cookie', 'afg=csrf-value; path=/',
    ])
    nock(BASE_URL).get('/web/api/identities').reply(200, identitiesFixture)
    nock(BASE_URL).get('/web/api/systems/systems/7654321').reply(200, systemFixture)

    nock(BASE_URL)
      .persist()
      .get('/web/api/devices/partitions')
      .query(true)
      .reply(200, { data: [partitionInState(1)] })

    nock(BASE_URL)
      .persist()
      .get('/web/api/devices/sensors')
      .query(true)
      .reply(200, (uri: string) => ({
        data: sensors.filter((sensor) => requestedIds(uri).includes(String(sensor.id))),
      }))
  }

  async function launch(): Promise<void> {
    new MyAlarmComPlatform(log, CONFIG, api.asApi())
    api.emit('didFinishLaunching')
    await waitFor(
      () => log.infoMessages.some((message) => message.includes('Ready')),
      { description: 'discovery to finish' },
    )
  }

  /** The security system's target characteristic, as HomeKit would reach it. */
  function targetCharacteristic() {
    const accessory = api.registered.find((candidate) =>
      candidate.services.some((service) => service.UUID === api.hap.Service.SecuritySystem.UUID))

    if (!accessory) {
      throw new Error('The platform never published a security system')
    }

    const characteristic = accessory.services
      .flatMap((service) => service.characteristics)
      .find((candidate) => candidate.UUID === api.hap.Characteristic.SecuritySystemTargetState.UUID)

    if (!characteristic) {
      throw new Error('The security system has no target state characteristic')
    }

    return characteristic
  }

  beforeEach(() => {
    api = new FakeHomebridgeApi()
    log = createHomebridgeLogging()
    interceptSignInAndDiscovery()
  })

  afterEach(() => {
    api.emit('shutdown')
    nock.cleanAll()
  })

  /**
   * Issue #65 in one assertion. The interceptor matches the content type, so
   * reusing the JSON:API `Accept` value for it — which is what shipped, and
   * what Alarm.com answered 500 to — leaves this request unmatched and fails.
   */
  it('sends an arm as JSON, to the action endpoint, and reports the new state', async () => {
    const command = nock(BASE_URL)
      .matchHeader('content-type', COMMAND_CONTENT_TYPE)
      .matchHeader('accept', 'application/vnd.api+json')
      .post(`/web/api/devices/partitions/${PARTITION_ID}/armStay`, {
        statePollOnly: false,
        noEntryDelay: false,
        silentArming: false,
      })
      .reply(200, { data: partitionInState(2) })

    await launch()
    await targetCharacteristic().handleSetRequest(
      api.hap.Characteristic.SecuritySystemTargetState.STAY_ARM,
    )

    expect(command.isDone()).toBe(true)
    expect(log.errors).toEqual([])
  })

  it('sends a disarm without the arming-only flags', async () => {
    const command = nock(BASE_URL)
      .matchHeader('content-type', COMMAND_CONTENT_TYPE)
      .post(`/web/api/devices/partitions/${PARTITION_ID}/disarm`, { statePollOnly: false })
      .reply(200, { data: partitionInState(1) })

    await launch()
    await targetCharacteristic().handleSetRequest(
      api.hap.Characteristic.SecuritySystemTargetState.DISARM,
    )

    expect(command.isDone()).toBe(true)
  })

  /**
   * The command reaching Alarm.com and being refused by it are different
   * things, and a 500 must not be reported to HomeKit as success.
   */
  it('surfaces a refused command instead of reporting it as done', async () => {
    nock(BASE_URL)
      .post(`/web/api/devices/partitions/${PARTITION_ID}/armAway`)
      .times(3)
      .reply(500, '{"errors":[{"status":"500","code":500}]}')

    await launch()

    await expect(
      targetCharacteristic().handleSetRequest(
        api.hap.Characteristic.SecuritySystemTargetState.AWAY_ARM,
      ),
    ).rejects.toBeDefined()

    expect(log.errors.join('\n')).toMatch(/could not reach Armed Away/)
  })

  /**
   * The invariant the whole integration rests on: a security system must never
   * disarm itself. Only a HomeKit write may reach the command endpoint, and
   * today that is true because there is exactly one call site — which nothing
   * would notice losing. Discovery, polling and a failing read all run here
   * with every command verb intercepted, so a future refactor that lets any of
   * them issue one fails as an unexpected request rather than in someone's
   * house.
   */
  /**
   * The fail-fast refusal, proved through the whole stack rather than against
   * a stubbed platform. Nothing is intercepted for the command endpoint, so if
   * the accessory sends one anyway the test fails on an unmatched request —
   * which is the behaviour being removed: a doomed command that Alarm.com holds
   * open until the 60-second ceiling expires.
   */
  it('refuses an arm over an open contact without sending anything', async () => {
    nock.cleanAll()
    interceptSignInAndDiscovery(sensorsFixture.data)
    await launch()

    await expect(
      targetCharacteristic().handleSetRequest(
        api.hap.Characteristic.SecuritySystemTargetState.STAY_ARM,
      ),
    ).rejects.toBe(-70412)

    expect(log.errors.join('\n')).toMatch(/cannot reach Armed Stay because Kitchen Window is open/)
  })

  it('never issues a command of its own accord', async () => {
    const anyCommand = nock(BASE_URL)
      .persist()
      .post(/\/web\/api\/devices\/partitions\/.*\/(armStay|armAway|disarm)$/)
      .reply(200, { data: partitionInState(1) })

    await launch()

    // A failing read on top of discovery, since error recovery is the plausible
    // place for a command to creep in: nothing about a partition read going
    // wrong justifies writing to the panel.
    nock(BASE_URL).get('/web/api/devices/partitions').query(true).reply(500, 'boom')
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(anyCommand.isDone()).toBe(false)
  })
})
