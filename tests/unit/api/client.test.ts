/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The client is driven through nock so the JSON:API envelopes, the batching,
 * and the command body are all asserted against real HTTP traffic. Pacing is
 * configured away here; it has its own tests and would only add latency.
 */

import nock from 'nock'
import { CircuitBreaker } from '../../../src/api/circuit-breaker'
import { AlarmComClient } from '../../../src/api/client'
import { RateLimiter } from '../../../src/api/rate-limiter'
import type { SessionManager } from '../../../src/api/session-manager'
import {
  ApiParseError,
  ForbiddenError,
  SystemUnavailableError,
} from '../../../src/errors'
import { BASE_URL, MAX_IDS_PER_REQUEST } from '../../../src/settings'
import type { PartitionAttributes, Resource } from '../../../src/types/alarm'
import * as retry from '../../../src/utils/retry'
import { captureRejection } from '../../helpers/errors'
import { createRecordingLogger, messagesAt } from '../../helpers/logger'
import identitiesFixture from '../../fixtures/identities.json'
import partitionsFixture from '../../fixtures/partitions.json'
import sensorsFixture from '../../fixtures/sensors.json'
import systemFixture from '../../fixtures/system.json'
import { fixtureAt } from '../../helpers/fixtures'

const SESSION = {
  cookieHeader: 'ASP.NET_SessionId=session-value; afg=csrf-value',
  ajaxKey: 'csrf-value',
  createdAt: new Date(),
}

interface SessionManagerStub {
  getSession: jest.Mock
  invalidate: jest.Mock
  hasSession: boolean
}

function createClient(): { client: AlarmComClient, sessionManager: SessionManagerStub } {
  const sessionManager: SessionManagerStub = {
    getSession: jest.fn().mockResolvedValue(SESSION),
    invalidate: jest.fn(),
    hasSession: true,
  }

  const client = new AlarmComClient({
    sessionManager: sessionManager as unknown as SessionManager,
    log: createRecordingLogger(),
    rateLimiter: new RateLimiter({ minIntervalMs: 0, maxRequests: 10_000, windowMs: 1_000 }),
  })

  return { client, sessionManager }
}

function idRange(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `1234567-${index + 1}`)
}

describe('AlarmComClient', () => {
  describe('getSystemId', () => {
    it('reads the selected system from the identity', async () => {
      const { client } = createClient()
      nock(BASE_URL).get('/web/api/identities').reply(200, identitiesFixture)

      await expect(client.getSystemId()).resolves.toBe('7654321')
    })

    it('sends the session cookies, the anti-CSRF key, and the JSON:API headers', async () => {
      const { client } = createClient()
      nock(BASE_URL)
        .matchHeader('cookie', SESSION.cookieHeader)
        .matchHeader('ajaxrequestuniquekey', SESSION.ajaxKey)
        .matchHeader('accept', 'application/vnd.api+json')
        .matchHeader('referer', 'https://www.alarm.com/web/system/home')
        .get('/web/api/identities')
        .reply(200, identitiesFixture)

      await expect(client.getSystemId()).resolves.toBe('7654321')
    })

    /**
     * Not a ConfigurationError: that means the *user's* config is wrong, which
     * ends startup permanently. Alarm.com omitting a system is either an
     * account problem or a partial response, and telling someone to fix a
     * setting they do not have is worse than retrying.
     */
    it('reports a retryable failure when the account has no selected system', async () => {
      const { client } = createClient()
      nock(BASE_URL).get('/web/api/identities').reply(200, { data: [{ id: '1', relationships: {} }] })

      const error = await captureRejection(client.getSystemId())

      expect(error).toBeInstanceOf(SystemUnavailableError)
      expect((error as SystemUnavailableError).isRetryable).toBe(true)
    })

    it('reports a retryable failure when the identity list is empty', async () => {
      const { client } = createClient()
      nock(BASE_URL).get('/web/api/identities').reply(200, { data: [] })

      await expect(client.getSystemId()).rejects.toThrow(SystemUnavailableError)
    })

    it('rejects a linkage carrying no usable id rather than querying for one', async () => {
      const { client } = createClient()
      nock(BASE_URL).get('/web/api/identities').reply(200, {
        data: [{ id: '1', relationships: { selectedSystem: { data: { type: 'systems/system' } } } }],
      })

      await expect(client.getSystemId()).rejects.toThrow(SystemUnavailableError)
    })
  })

  /**
   * A poll cycle is several requests and it runs every interval, so a log holds
   * thousands of near-identical lines a day. Without a tag there is no way to
   * tell which retry, which session recovery, and which failure belong together.
   */
  describe('request correlation', () => {
    it('tags a failure with an id and how long it took', async () => {
      const { client } = createClient()
      nock(BASE_URL).get('/web/api/identities').times(3).reply(500, 'boom')

      const error = await captureRejection(client.getSystemId())

      expect(error.message).toMatch(/\[[0-9a-f]{6}, \d+ms\]$/)
    })

    it('reuses the same tag across every retry of one request', async () => {
      const log = createRecordingLogger()
      const client = new AlarmComClient({
        sessionManager: {
          getSession: jest.fn().mockResolvedValue(SESSION),
          invalidate: jest.fn(),
          hasSession: true,
        } as unknown as SessionManager,
        log,
        rateLimiter: new RateLimiter({ minIntervalMs: 0, maxRequests: 10_000, windowMs: 1_000 }),
      })
      nock(BASE_URL).get('/web/api/identities').times(2).reply(500, 'boom')
      nock(BASE_URL).get('/web/api/identities').reply(200, identitiesFixture)

      await expect(client.getSystemId()).resolves.toBe('7654321')

      const tags = messagesAt(log, 'debug')
        .filter((line) => line.startsWith('retrying '))
        .map((line) => /\[([0-9a-f]{6})\]/.exec(line)?.[1])

      expect(tags).toHaveLength(2)
      expect(new Set(tags).size).toBe(1)
    })

    it('gives separate requests separate tags', async () => {
      const { client } = createClient()
      nock(BASE_URL).get('/web/api/identities').times(2).reply(500, 'boom')
      nock(BASE_URL).get('/web/api/identities').reply(500, 'boom')
      const first = await captureRejection(client.getSystemId())

      nock(BASE_URL).get('/web/api/identities').times(3).reply(500, 'boom')
      const second = await captureRejection(client.getSystemId())

      const tagOf = (message: string): string => /\[([0-9a-f]{6})/.exec(message)?.[1] ?? ''
      expect(tagOf(first.message)).not.toBe(tagOf(second.message))
    })
  })

  describe('getSystemDevices', () => {
    it('extracts the partition and sensor ids, ignoring other relationships', async () => {
      const { client } = createClient()
      nock(BASE_URL).get('/web/api/systems/systems/7654321').reply(200, systemFixture)

      await expect(client.getSystemDevices('7654321')).resolves.toEqual({
        partitionIds: ['1234567-127'],
        sensorIds: ['1234567-1', '1234567-2', '1234567-15', '1234567-16', '1234567-20'],
      })
    })

    it('reports no devices when the system lists none', async () => {
      const { client } = createClient()
      nock(BASE_URL)
        .get('/web/api/systems/systems/7654321')
        .reply(200, { data: { id: '7654321', type: 'systems/system', attributes: {} } })

      await expect(client.getSystemDevices('7654321')).resolves.toEqual({
        partitionIds: [],
        sensorIds: [],
      })
    })

    it('accepts a relationship holding a single linkage rather than a list', async () => {
      const { client } = createClient()
      nock(BASE_URL).get('/web/api/systems/systems/7654321').reply(200, {
        data: {
          id: '7654321',
          type: 'systems/system',
          attributes: {},
          relationships: { partitions: { data: { id: '1234567-127', type: 'devices/partition' } } },
        },
      })

      await expect(client.getSystemDevices('7654321')).resolves.toMatchObject({
        partitionIds: ['1234567-127'],
      })
    })
  })

  describe('getSensors', () => {
    it('splits 120 ids across three batched requests', async () => {
      const { client } = createClient()
      const batches: string[][] = []

      nock(BASE_URL)
        .get('/web/api/devices/sensors')
        .query(true)
        .times(3)
        .reply(200, (uri) => {
          batches.push(new URL(uri, BASE_URL).searchParams.getAll('ids[]'))
          return { data: [] }
        })

      await client.getSensors(idRange(120))

      expect(batches.map((batch) => batch.length)).toEqual([50, 50, 20])
      expect(batches.flat()).toEqual(idRange(120))
    })

    /** Alarm.com answers an oversized query string with a 404, not a useful error. */
    it.each([
      [MAX_IDS_PER_REQUEST, 1],
      [MAX_IDS_PER_REQUEST + 1, 2],
    ])('sends %i ids as %i request(s)', async (idCount, requestCount) => {
      const { client } = createClient()
      let seen = 0

      nock(BASE_URL)
        .get('/web/api/devices/sensors')
        .query(true)
        .times(requestCount)
        .reply(200, () => {
          seen++
          return { data: [] }
        })

      await client.getSensors(idRange(idCount))

      expect(seen).toBe(requestCount)
    })

    it('joins the batched responses into one list', async () => {
      const { client } = createClient()
      nock(BASE_URL)
        .get('/web/api/devices/sensors')
        .query(true)
        .reply(200, sensorsFixture)

      const sensors = await client.getSensors(['1234567-1', '1234567-2'])

      expect(sensors).toHaveLength(6)
      expect(fixtureAt(sensors, 0, 'sensors').attributes.description).toBe('Front Door')
    })

    it('makes no request at all for an empty id list', async () => {
      const { client } = createClient()

      await expect(client.getSensors([])).resolves.toEqual([])
      expect(nock.pendingMocks()).toEqual([])
    })

    it('copes with a batch that came back without a data member', async () => {
      const { client } = createClient()
      nock(BASE_URL).get('/web/api/devices/sensors').query(true).reply(200, {})

      await expect(client.getSensors(['1234567-1'])).resolves.toEqual([])
    })
  })

  describe('getPartitions', () => {
    it('reads the partition collection', async () => {
      const { client } = createClient()
      nock(BASE_URL).get('/web/api/devices/partitions').query(true).reply(200, partitionsFixture)

      const partitions = await client.getPartitions(['1234567-127'])

      expect(partitions).toHaveLength(1)
      expect(fixtureAt(partitions, 0, 'partitions').attributes.hasPermissionToChangeState).toBe(false)
    })
  })

  describe('commandPartition', () => {
    const partitionId = '1234567-127'
    const partitionResponse = { data: fixtureAt(partitionsFixture.data, 0, 'partitions') }

    // Alarm.com negotiates on application/vnd.api+json, which nock does not
    // recognise as JSON, so the request body arrives as raw text.
    async function captureCommandBody(
      run: (client: AlarmComClient) => Promise<Resource<PartitionAttributes>>,
      action: string,
    ): Promise<Record<string, unknown>> {
      const { client } = createClient()
      let body: Record<string, unknown> = {}

      nock(BASE_URL)
        .post(`/web/api/devices/partitions/${partitionId}/${action}`)
        .reply(200, (_uri, requestBody) => {
          body = JSON.parse(String(requestBody)) as Record<string, unknown>
          return partitionResponse
        })

      await run(client)
      return body
    }

    it('posts to the action endpoint and returns the updated partition', async () => {
      const { client } = createClient()
      nock(BASE_URL)
        .post(`/web/api/devices/partitions/${partitionId}/armAway`)
        .reply(200, partitionResponse)

      const partition = await client.commandPartition(partitionId, 'armAway')

      expect(partition.id).toBe(partitionId)
    })

    it('re-authenticates once when a command hits a lapsed session', async () => {
      const { client, sessionManager } = createClient()
      nock(BASE_URL)
        .post(`/web/api/devices/partitions/${partitionId}/disarm`)
        .reply(401, '{"errors":["Unauthorized"]}')
      nock(BASE_URL)
        .post(`/web/api/devices/partitions/${partitionId}/disarm`)
        .reply(200, partitionResponse)

      await expect(client.commandPartition(partitionId, 'disarm')).resolves.toMatchObject({
        id: partitionId,
      })
      expect(sessionManager.invalidate).toHaveBeenCalledTimes(1)
      expect(sessionManager.getSession).toHaveBeenCalledTimes(2)
    })

    it('always asks for a real command rather than a state poll', async () => {
      const body = await captureCommandBody(
        (client) => client.commandPartition(partitionId, 'armStay'),
        'armStay',
      )

      expect(body.statePollOnly).toBe(false)
    })

    it('sends the entry-delay and silent-arming flags explicitly when arming', async () => {
      const body = await captureCommandBody(
        (client) => client.commandPartition(partitionId, 'armStay'),
        'armStay',
      )

      expect(body).toEqual({ statePollOnly: false, noEntryDelay: false, silentArming: false })
    })

    it('omits both of those flags on a disarm, which has no use for them', async () => {
      const body = await captureCommandBody(
        (client) => client.commandPartition(partitionId, 'disarm'),
        'disarm',
      )

      expect(body).toEqual({ statePollOnly: false })
    })

    it('omits nightArming and forceBypass unless they were asked for', async () => {
      const body = await captureCommandBody(
        (client) => client.commandPartition(partitionId, 'armStay', {
          nightArming: false,
          forceBypass: false,
        }),
        'armStay',
      )

      expect(body).not.toHaveProperty('nightArming')
      expect(body).not.toHaveProperty('forceBypass')
    })

    it('includes nightArming and forceBypass when they were', async () => {
      const body = await captureCommandBody(
        (client) => client.commandPartition(partitionId, 'armStay', {
          nightArming: true,
          forceBypass: true,
        }),
        'armStay',
      )

      // The two arming modifiers HomeKit can express are conditional; the two it
      // cannot are always present and always false, which is what the observed
      // protocol expects.
      expect(body).toEqual({
        statePollOnly: false,
        noEntryDelay: false,
        silentArming: false,
        nightArming: true,
        forceBypass: true,
      })
    })

    it('escapes a partition id into the path', async () => {
      const { client } = createClient()
      nock(BASE_URL)
        .post('/web/api/devices/partitions/1234567%2F127/disarm')
        .reply(200, partitionResponse)

      await expect(client.commandPartition('1234567/127', 'disarm')).resolves.toBeDefined()
    })

    it('surfaces a permission failure rather than retrying it', async () => {
      const { client } = createClient()
      nock(BASE_URL)
        .post(`/web/api/devices/partitions/${partitionId}/armAway`)
        .reply(403, '{"errors":["Forbidden"]}')

      await expect(client.commandPartition(partitionId, 'armAway')).rejects.toThrow(ForbiddenError)
    })

    it('re-authenticates once when a command is rejected with a 401', async () => {
      const { client, sessionManager } = createClient()
      nock(BASE_URL)
        .post(`/web/api/devices/partitions/${partitionId}/disarm`)
        .reply(401, '{"errors":["Unauthorized"]}')
      nock(BASE_URL)
        .post(`/web/api/devices/partitions/${partitionId}/disarm`)
        .reply(200, partitionResponse)

      await expect(client.commandPartition(partitionId, 'disarm')).resolves.toMatchObject({
        id: partitionId,
      })
      expect(sessionManager.invalidate).toHaveBeenCalledTimes(1)
    })

    /**
     * A command is not idempotent, and an unparseable body is not a rejection.
     *
     * `ApiParseError` is only ever raised after `response.ok`, so an HTML
     * interstitial on a command means the panel very likely *accepted* it. A read
     * may safely replay on that signal; replaying a command would send a second
     * arm — a second exit-delay countdown for the user, or a second siren.
     */
    it('does not replay a command whose response was merely unparseable', async () => {
      const { client, sessionManager } = createClient()
      const interceptor = nock(BASE_URL)
        .post(`/web/api/devices/partitions/${partitionId}/armStay`)
        .reply(200, '<!DOCTYPE html><html><body>Sign in to Alarm.com</body></html>')

      const error = await captureRejection(client.commandPartition(partitionId, 'armStay'))

      expect(error).toBeInstanceOf(ApiParseError)
      expect(error.message).toMatch(/the session may have expired/)
      expect(error.message).not.toContain('?')
      expect(sessionManager.invalidate).not.toHaveBeenCalled()
      expect(interceptor.isDone()).toBe(true)
      expect(nock.pendingMocks()).toEqual([])
    })

    it('surfaces a parse failure when re-authentication still returns HTML', async () => {
      const { client, sessionManager } = createClient()
      nock(BASE_URL)
        .post(`/web/api/devices/partitions/${partitionId}/disarm`)
        .reply(401, '{"errors":["Unauthorized"]}')
      nock(BASE_URL)
        .post(`/web/api/devices/partitions/${partitionId}/disarm`)
        .reply(200, '<!DOCTYPE html><html><body>Sign in to Alarm.com</body></html>')

      const error = await captureRejection(client.commandPartition(partitionId, 'disarm'))

      expect(error).toBeInstanceOf(ApiParseError)
      expect(sessionManager.invalidate).toHaveBeenCalledTimes(1)
    })
  })

  describe('getEventStreamToken', () => {
    it('reads the flat object this one endpoint returns', async () => {
      const { client } = createClient()
      nock(BASE_URL)
        .get('/web/api/websockets/token')
        .reply(200, {
          value: 'stream-token',
          metaData: { endpoint: 'wss://webskt.alarm.com:8443' },
        })

      await expect(client.getEventStreamToken()).resolves.toEqual({
        token: 'stream-token',
        endpoint: 'wss://webskt.alarm.com:8443',
      })
    })

    it('omits the endpoint when Alarm.com does not name one', async () => {
      const { client } = createClient()
      nock(BASE_URL).get('/web/api/websockets/token').reply(200, { value: 'stream-token' })

      await expect(client.getEventStreamToken()).resolves.toEqual({ token: 'stream-token' })
    })

    it('omits the endpoint when the metadata carries no endpoint', async () => {
      const { client } = createClient()
      nock(BASE_URL).get('/web/api/websockets/token').reply(200, { value: 'stream-token', metaData: {} })

      await expect(client.getEventStreamToken()).resolves.toEqual({ token: 'stream-token' })
    })

    it('complains when no token came back', async () => {
      const { client } = createClient()
      nock(BASE_URL).get('/web/api/websockets/token').reply(200, {})

      await expect(client.getEventStreamToken()).rejects.toThrow(ApiParseError)
    })
  })

  describe('a lapsed session', () => {
    it('is re-established once and the request retried', async () => {
      const { client, sessionManager } = createClient()
      nock(BASE_URL).get('/web/api/identities').reply(401, '{"errors":["Unauthorized"]}')
      nock(BASE_URL).get('/web/api/identities').reply(200, identitiesFixture)

      await expect(client.getSystemId()).resolves.toBe('7654321')
      expect(sessionManager.invalidate).toHaveBeenCalledTimes(1)
      expect(sessionManager.getSession).toHaveBeenCalledTimes(2)
    })

    /**
     * Regression. Alarm.com announces a lapsed session two ways: a 401, and an
     * HTTP 200 carrying the HTML login page. Only the 401 invalidated the
     * session, so the HTML case kept replaying dead cookies until the auth
     * interval elapsed, turning a one-request recovery into minutes of failing
     * polls.
     */
    it('is re-established when the lapse arrives as an HTML login page', async () => {
      const { client, sessionManager } = createClient()
      nock(BASE_URL)
        .get('/web/api/identities')
        .reply(200, '<!DOCTYPE html><html><body>Sign in to Alarm.com</body></html>')
      nock(BASE_URL).get('/web/api/identities').reply(200, identitiesFixture)

      await expect(client.getSystemId()).resolves.toBe('7654321')
      expect(sessionManager.invalidate).toHaveBeenCalledTimes(1)
      expect(sessionManager.getSession).toHaveBeenCalledTimes(2)
    })

    it('does not multiply re-logins when the HTML login page persists', async () => {
      const { client, sessionManager } = createClient()
      nock(BASE_URL)
        .get('/web/api/identities')
        .times(2)
        .reply(200, '<!DOCTYPE html><html><body>Sign in to Alarm.com</body></html>')

      await expect(client.getSystemId()).rejects.toThrow(ApiParseError)
      expect(sessionManager.invalidate).toHaveBeenCalledTimes(1)
      expect(sessionManager.getSession).toHaveBeenCalledTimes(2)
    })
  })

  describe('rate limiting', () => {
    afterEach(() => {
      jest.restoreAllMocks()
    })

    it('honours Retry-After from a 429 before retrying', async () => {
      const wait = jest.spyOn(retry, 'sleep').mockResolvedValue(undefined)
      const { client } = createClient()
      nock(BASE_URL)
        .get('/web/api/identities')
        .reply(429, 'slow down', { 'Retry-After': '7' })
      nock(BASE_URL).get('/web/api/identities').reply(200, identitiesFixture)

      await expect(client.getSystemId()).resolves.toBe('7654321')
      expect(wait).toHaveBeenCalledWith(7_000, undefined)
    })
  })

  describe('getStatus', () => {
    it('reports the state of each resilience layer', () => {
      const { client } = createClient()

      expect(client.getStatus()).toMatchObject({
        circuitBreaker: { state: 'CLOSED' },
        rateLimiter: { remaining: expect.any(Number) },
        hasSession: true,
      })
    })
  })

  describe('circuit breaker logging', () => {
    afterEach(() => {
      jest.restoreAllMocks()
    })

    it('warns when sustained failures open the breaker', async () => {
      jest.spyOn(retry, 'sleep').mockResolvedValue(undefined)
      const log = createRecordingLogger()
      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeoutMs: 1_000,
        successesToClose: 1,
        halfOpenProbes: 1,
        failureWindowMs: 60_000,
        // Off, so this test's back-to-back retries count individually. Coalescing
        // is what stops one failing request being read as several, and it is
        // asserted in the breaker's own suite.
        failureCoalesceMs: 0,
      })
      const sessionManager: SessionManagerStub = {
        getSession: jest.fn().mockResolvedValue(SESSION),
        invalidate: jest.fn(),
        hasSession: true,
      }
      const client = new AlarmComClient({
        sessionManager: sessionManager as unknown as SessionManager,
        log,
        circuitBreaker: breaker,
        rateLimiter: new RateLimiter({ minIntervalMs: 0, maxRequests: 10_000, windowMs: 1_000 }),
      })

      nock(BASE_URL).get('/web/api/identities').times(10).reply(500, 'unavailable')

      await expect(client.getSystemId()).rejects.toThrow()

      expect(messagesAt(log, 'warn')).toContain('Circuit breaker CLOSED -> OPEN')
    })

    /**
     * Only the edges into and out of "unavailable" are loud.
     *
     * During an outage the breaker necessarily flaps OPEN -> HALF_OPEN -> OPEN
     * once per poll cycle as the cooldown elapses and the probe fails. Logging
     * each of those at info and warn was 2,880 lines a day, arriving in the log an
     * operator is reading to understand the outage.
     */
    it('reports the outage and the recovery, and keeps the probe churn quiet', async () => {
      jest.useFakeTimers()
      const log = createRecordingLogger()
      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeoutMs: 1_000,
        successesToClose: 1,
        halfOpenProbes: 1,
        failureWindowMs: 60_000,
        failureCoalesceMs: 0,
      })
      const sessionManager: SessionManagerStub = {
        getSession: jest.fn().mockResolvedValue(SESSION),
        invalidate: jest.fn(),
        hasSession: true,
      }
      new AlarmComClient({
        sessionManager: sessionManager as unknown as SessionManager,
        log,
        circuitBreaker: breaker,
        rateLimiter: new RateLimiter({ minIntervalMs: 0, maxRequests: 10_000, windowMs: 1_000 }),
      })

      breaker.recordFailure()
      breaker.recordFailure()
      expect(messagesAt(log, 'warn')).toEqual([
        'Circuit breaker CLOSED -> OPEN',
      ])

      // Two failed probe cycles: each moves OPEN -> HALF_OPEN -> OPEN, and neither
      // says anything the first warning did not.
      for (let cycle = 0; cycle < 2; cycle++) {
        jest.advanceTimersByTime(1_000)
        expect(breaker.canRequest()).toBe(true)
        await expect(breaker.execute(() => Promise.reject(new Error('still down'))))
          .rejects.toThrow('still down')
      }

      expect(messagesAt(log, 'warn')).toHaveLength(1)
      expect(messagesAt(log, 'info')).toEqual([])
      expect(messagesAt(log, 'debug').join('\n')).toContain('Circuit breaker OPEN -> HALF_OPEN')

      jest.advanceTimersByTime(1_000)
      expect(breaker.canRequest()).toBe(true)
      await expect(breaker.execute(() => Promise.resolve('ok'))).resolves.toBe('ok')

      expect(messagesAt(log, 'info')).toEqual([
        'Circuit breaker HALF_OPEN -> CLOSED',
      ])

      jest.useRealTimers()
    })
  })
})
