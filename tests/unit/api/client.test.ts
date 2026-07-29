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
import { AlarmComClient, chunkIds } from '../../../src/api/client'
import { RateLimiter } from '../../../src/api/rate-limiter'
import type { SessionManager } from '../../../src/api/session-manager'
import { ApiParseError, ConfigurationError, ForbiddenError } from '../../../src/errors'
import { BASE_URL, MAX_IDS_PER_REQUEST } from '../../../src/settings'
import type { PartitionAttributes, Resource } from '../../../src/types/alarm'
import * as retry from '../../../src/utils/retry'
import { captureRejection } from '../../helpers/errors'
import { createRecordingLogger, messagesAt } from '../../helpers/logger'
import identitiesFixture from '../../fixtures/identities.json'
import partitionsFixture from '../../fixtures/partitions.json'
import sensorsFixture from '../../fixtures/sensors.json'
import systemFixture from '../../fixtures/system.json'

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

describe('chunkIds', () => {
  it('batches at the fifty-id ceiling Alarm.com enforces with a 404', () => {
    const chunks = chunkIds(idRange(120))

    expect(chunks.map((chunk) => chunk.length)).toEqual([50, 50, 20])
    expect(MAX_IDS_PER_REQUEST).toBe(50)
  })

  it('leaves a list that already fits in one batch', () => {
    expect(chunkIds(idRange(50))).toHaveLength(1)
    expect(chunkIds(idRange(51))).toHaveLength(2)
  })

  it('produces nothing for an empty list', () => {
    expect(chunkIds([])).toEqual([])
  })

  it('honours a caller-supplied batch size', () => {
    expect(chunkIds(idRange(5), 2).map((chunk) => chunk.length)).toEqual([2, 2, 1])
  })

  it('keeps every id, in order', () => {
    expect(chunkIds(idRange(120)).flat()).toEqual(idRange(120))
  })
})

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

    it('complains when the account reports no selected system', async () => {
      const { client } = createClient()
      nock(BASE_URL).get('/web/api/identities').reply(200, { data: [{ id: '1', relationships: {} }] })

      await expect(client.getSystemId()).rejects.toThrow(ConfigurationError)
    })

    it('complains when the identity list is empty', async () => {
      const { client } = createClient()
      nock(BASE_URL).get('/web/api/identities').reply(200, { data: [] })

      await expect(client.getSystemId()).rejects.toThrow(ConfigurationError)
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

    it('joins the batched responses into one list', async () => {
      const { client } = createClient()
      nock(BASE_URL)
        .get('/web/api/devices/sensors')
        .query(true)
        .reply(200, sensorsFixture)

      const sensors = await client.getSensors(['1234567-1', '1234567-2'])

      expect(sensors).toHaveLength(6)
      expect(sensors[0].attributes.description).toBe('Front Door')
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
      expect(partitions[0].attributes.hasPermissionToChangeState).toBe(false)
    })
  })

  describe('commandPartition', () => {
    const partitionId = '1234567-127'
    const partitionResponse = { data: partitionsFixture.data[0] }

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
          noEntryDelay: true,
          silentArming: true,
          nightArming: true,
          forceBypass: true,
        }),
        'armStay',
      )

      expect(body).toEqual({
        statePollOnly: false,
        noEntryDelay: true,
        silentArming: true,
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

    it('re-authenticates once when a command gets an HTML login page', async () => {
      const { client, sessionManager } = createClient()
      nock(BASE_URL)
        .post(`/web/api/devices/partitions/${partitionId}/disarm`)
        .reply(200, '<!DOCTYPE html><html><body>Sign in to Alarm.com</body></html>')
      nock(BASE_URL)
        .post(`/web/api/devices/partitions/${partitionId}/disarm`)
        .reply(200, partitionResponse)

      await expect(client.commandPartition(partitionId, 'disarm')).resolves.toMatchObject({
        id: partitionId,
      })
      expect(sessionManager.invalidate).toHaveBeenCalledTimes(1)
    })

    it('surfaces a parse failure when re-authentication still returns HTML', async () => {
      const { client, sessionManager } = createClient()
      nock(BASE_URL)
        .post(`/web/api/devices/partitions/${partitionId}/disarm`)
        .times(2)
        .reply(200, '<!DOCTYPE html><html><body>Sign in to Alarm.com</body></html>')

      const error = await captureRejection(client.commandPartition(partitionId, 'disarm'))

      expect(error).toBeInstanceOf(ApiParseError)
      expect(error.message).toMatch(/the session may have expired/)
      expect(error.message).not.toContain('?')
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
      expect(wait).toHaveBeenCalledWith(7_000)
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
        halfOpenMax: 1,
        failureWindowMs: 60_000,
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

    it('logs recovery through HALF_OPEN back to CLOSED', async () => {
      jest.useFakeTimers()
      const log = createRecordingLogger()
      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeoutMs: 1_000,
        halfOpenMax: 1,
        failureWindowMs: 60_000,
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
      expect(messagesAt(log, 'warn')).toContain('Circuit breaker CLOSED -> OPEN')

      jest.advanceTimersByTime(1_000)
      expect(breaker.canRequest()).toBe(true)
      expect(messagesAt(log, 'info')).toContain('Circuit breaker OPEN -> HALF_OPEN')

      await expect(breaker.execute(async () => 'ok')).resolves.toBe('ok')
      expect(messagesAt(log, 'info')).toContain('Circuit breaker HALF_OPEN -> CLOSED')

      jest.useRealTimers()
    })
  })
})
