/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The transport is mocked rather than driven through nock, because the property
 * under test is the deadline handed to it. Provoking a real timeout would mean
 * waiting out the very interval being asserted.
 */

import { AlarmComClient } from '../../../src/api/client'
import { RateLimiter } from '../../../src/api/rate-limiter'
import type { SessionManager } from '../../../src/api/session-manager'
import { httpRequest } from '../../../src/api/http'
import type { HttpRequestOptions } from '../../../src/api/http'
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  PARTITION_COMMAND_TIMEOUT_MS,
} from '../../../src/settings'
import { createRecordingLogger } from '../../helpers/logger'
import partitionsFixture from '../../fixtures/partitions.json'
import { fixtureAt } from '../../helpers/fixtures'

jest.mock('../../../src/api/http', () => ({ httpRequest: jest.fn() }))

const mockedRequest = httpRequest as jest.MockedFunction<typeof httpRequest>

const SESSION = {
  cookieHeader: 'ASP.NET_SessionId=session-value; afg=csrf-value',
  ajaxKey: 'csrf-value',
  createdAt: new Date(),
}

function createClient(): AlarmComClient {
  return new AlarmComClient({
    sessionManager: {
      getSession: jest.fn().mockResolvedValue(SESSION),
      invalidate: jest.fn(),
      hasSession: true,
    } as unknown as SessionManager,
    log: createRecordingLogger(),
    rateLimiter: new RateLimiter({ minIntervalMs: 0, maxRequests: 10_000, windowMs: 1_000 }),
  })
}

/** The shape `#send` reads off a transport response. */
function respondWith(payload: unknown): void {
  mockedRequest.mockResolvedValue({
    ok: true,
    status: 200,
    text: JSON.stringify(payload),
    headers: new Headers(),
  })
}

/** The deadline handed to the transport for the most recent call. */
function lastTimeoutMs(): number | undefined {
  const options: HttpRequestOptions | undefined = mockedRequest.mock.calls.at(-1)?.[1]
  return options?.timeoutMs
}

describe('request deadlines', () => {
  beforeEach(() => {
    mockedRequest.mockReset()
  })

  /**
   * Regression. Alarm.com holds a command open until the panel acknowledges, so
   * the panel's own response time is inside the request. Measured live: 17.6s
   * and 19.4s to arm, 25.4s to disarm, against a 30s read ceiling. A command
   * that trips that ceiling is reported to the user as a failed arm while the
   * panel goes on arming.
   */
  it('gives an arming command longer than a read', async () => {
    respondWith({ data: fixtureAt(partitionsFixture.data, 0, 'partitions') })

    await createClient().commandPartition('1234567-127', 'armAway')

    expect(lastTimeoutMs()).toBe(PARTITION_COMMAND_TIMEOUT_MS)
    expect(PARTITION_COMMAND_TIMEOUT_MS).toBeGreaterThan(DEFAULT_REQUEST_TIMEOUT_MS)
  })

  it('leaves a read on the transport default', async () => {
    respondWith(partitionsFixture)

    await createClient().getPartitions(['1234567-127'])

    expect(lastTimeoutMs()).toBeUndefined()
  })
})
