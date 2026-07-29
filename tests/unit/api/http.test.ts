/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Two properties matter here beyond "it fetches": every request has a deadline,
 * and no failure message may carry a query string, because Alarm.com puts the
 * event stream token in one.
 */

import nock from 'nock'
import { httpRequest, USER_AGENT } from '../../../src/api/http'
import { AlarmComError, NetworkError, TimeoutError } from '../../../src/errors'
import { BASE_URL } from '../../../src/settings'
import { captureRejection } from '../../helpers/errors'

describe('httpRequest', () => {
  it('performs a GET and returns the response', async () => {
    nock(BASE_URL).get('/web/KeepAlive.aspx').reply(200, '{"status":200}')

    const response = await httpRequest(`${BASE_URL}/web/KeepAlive.aspx`)

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('{"status":200}')
  })

  it('identifies the plugin honestly rather than impersonating a browser', async () => {
    nock(BASE_URL)
      .matchHeader('user-agent', USER_AGENT)
      .get('/web/KeepAlive.aspx')
      .reply(200, '')

    await expect(httpRequest(`${BASE_URL}/web/KeepAlive.aspx`)).resolves.toMatchObject({ status: 200 })
    expect(USER_AGENT).toMatch(/^homebridge-myalarmcom\//)
  })

  it('sends the caller headers and body', async () => {
    let seenBody = ''
    nock(BASE_URL)
      .matchHeader('content-type', 'application/x-www-form-urlencoded')
      .post('/web/Default.aspx')
      .reply(200, (_uri, body) => {
        seenBody = String(body)
        return ''
      })

    await httpRequest(`${BASE_URL}/web/Default.aspx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ IsFromNewSite: '1' }),
    })

    expect(seenBody).toBe('IsFromNewSite=1')
  })

  it('does not follow redirects, so login cookies are not discarded', async () => {
    nock(BASE_URL)
      .post('/web/Default.aspx')
      .reply(302, '', { Location: '/web/system/home' })

    const response = await httpRequest(`${BASE_URL}/web/Default.aspx`, { method: 'POST' })

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/web/system/home')
  })

  it('abandons a request that outlives its deadline', async () => {
    nock(BASE_URL).get('/web/KeepAlive.aspx').delay(500).reply(200, '')
    const startedAt = Date.now()

    const error = await captureRejection(httpRequest(`${BASE_URL}/web/KeepAlive.aspx`, { timeoutMs: 20 }))

    expect(error).toBeInstanceOf(AlarmComError)
    expect((error as AlarmComError).isRetryable).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(400)
  })

  it('classifies an aborted request as a timeout', async () => {
    // The abort has to be simulated. Node's real fetch rejects with a
    // DOMException, and inside Jest's VM context a DOMException fails
    // `instanceof Error` because it inherits from the host realm's Error, so a
    // genuinely aborted request cannot reach the timeout branch under test.
    const aborted = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(aborted)

    const error = await captureRejection(httpRequest(`${BASE_URL}/web/KeepAlive.aspx`, { timeoutMs: 20 }))

    expect(error).toBeInstanceOf(TimeoutError)
    expect(error.message).toBe('Request to https://www.alarm.com/web/KeepAlive.aspx timed out after 20ms')
  })

  it('raises a NetworkError when the request fails below the HTTP layer', async () => {
    nock(BASE_URL).get('/web/KeepAlive.aspx').replyWithError({ code: 'ECONNREFUSED' })

    await expect(httpRequest(`${BASE_URL}/web/KeepAlive.aspx`)).rejects.toThrow(NetworkError)
  })

  it('keeps the original failure as the cause of a NetworkError', async () => {
    const underlying = new Error('socket hang up')
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(underlying)

    const error = await captureRejection(httpRequest(`${BASE_URL}/web/KeepAlive.aspx`))

    expect(error).toBeInstanceOf(NetworkError)
    expect(error.cause).toBe(underlying)
  })

  it('keeps the query string out of failure messages', async () => {
    const url = `${BASE_URL}/web/api/websockets/token?auth=super-secret-token`
    nock(BASE_URL).get('/web/api/websockets/token').query(true).replyWithError({ code: 'ECONNRESET' })

    const error = await captureRejection(httpRequest(url))

    expect(error.message).toContain('https://www.alarm.com/web/api/websockets/token')
    expect(error.message).not.toContain('super-secret-token')
  })

  it('keeps the query string out of timeout messages too', async () => {
    const aborted = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(aborted)

    const url = `${BASE_URL}/web/api/websockets/token?auth=super-secret-token`
    const error = await captureRejection(httpRequest(url, { timeoutMs: 20 }))

    expect(error).toBeInstanceOf(TimeoutError)
    expect(error.message).not.toContain('super-secret-token')
  })
})
