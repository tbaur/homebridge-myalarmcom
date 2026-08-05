/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Signing in is the request Alarm.com polices hardest, so every test here is
 * ultimately about how few logins the manager performs.
 */

import { SessionManager } from '../../../src/api/session-manager'
import { authenticate, keepAlive, type Session } from '../../../src/api/auth'
import {
  AuthenticationError,
  LoginThrottledError,
  TwoFactorRequiredError,
} from '../../../src/errors'
import { sleep } from '../../../src/utils/retry'
import { createRecordingLogger, messagesAt, type RecordingLogger } from '../../helpers/logger'

jest.mock('../../../src/api/auth')

jest.mock('../../../src/utils/retry', () => {
  const actual = jest.requireActual<typeof import('../../../src/utils/retry')>('../../../src/utils/retry')
  return { ...actual, sleep: jest.fn() }
})

const mockedAuthenticate = jest.mocked(authenticate)
const mockedKeepAlive = jest.mocked(keepAlive)
const mockedSleep = jest.mocked(sleep)

const CREDENTIALS = {
  username: 'user@example.com',
  password: 'correct-horse-battery',
  twoFactorAuthenticationId: 'a'.repeat(64),
}

function aSession(): Session {
  return { cookieHeader: 'afg=csrf-value', ajaxKey: 'csrf-value' }
}

describe('SessionManager', () => {
  let log: RecordingLogger

  function createManager(authIntervalMinutes = 10): SessionManager {
    return new SessionManager({ credentials: CREDENTIALS, authIntervalMinutes, log })
  }

  beforeEach(() => {
    jest.useFakeTimers()
    log = createRecordingLogger()
    mockedSleep.mockResolvedValue(undefined)
    mockedAuthenticate.mockImplementation(() => Promise.resolve(aSession()))
    mockedKeepAlive.mockResolvedValue(true)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('signs in on the first request for a session', async () => {
    const manager = createManager()

    const session = await manager.getSession()

    expect(session.ajaxKey).toBe('csrf-value')
    expect(mockedAuthenticate).toHaveBeenCalledWith(CREDENTIALS, log, undefined)
    expect(manager.hasSession).toBe(true)
  })

  it('reuses a session that is still within its lifetime', async () => {
    const manager = createManager()
    await manager.getSession()

    jest.advanceTimersByTime(5 * 60_000)
    await manager.getSession()

    expect(mockedAuthenticate).toHaveBeenCalledTimes(1)
  })

  it('signs in again once the session is older than its lifetime', async () => {
    const manager = createManager()
    await manager.getSession()

    jest.advanceTimersByTime(10 * 60_000 + 1)
    await manager.getSession()

    expect(mockedAuthenticate).toHaveBeenCalledTimes(2)
  })

  it('makes concurrent callers share a single sign-in', async () => {
    const manager = createManager()

    const sessions = await Promise.all([
      manager.getSession(),
      manager.getSession(),
      manager.getSession(),
    ])

    expect(mockedAuthenticate).toHaveBeenCalledTimes(1)
    expect(new Set(sessions).size).toBe(1)
  })

  /**
   * The floor can be a whole day. Sleeping through it inside `getSession()`
   * blocks the poll cycle, and any HomeKit arm or disarm queued behind it, for
   * exactly that long — so a long remainder is refused instead of waited out.
   */
  it('refuses rather than blocks when the login floor has a long way to run', async () => {
    const manager = createManager()
    await manager.getSession()
    manager.invalidate()

    jest.advanceTimersByTime(60_000)

    const error = await manager.getSession().then(() => null, (thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(LoginThrottledError)
    expect((error as LoginThrottledError).retryAfterMs).toBe(10 * 60_000 - 60_000)
    expect((error as LoginThrottledError).isRetryable).toBe(true)
    expect(mockedSleep).not.toHaveBeenCalled()
    expect(mockedAuthenticate).toHaveBeenCalledTimes(1)
  })

  it('simply waits when only a moment of the floor is left', async () => {
    const manager = createManager()
    await manager.getSession()
    manager.invalidate()

    jest.advanceTimersByTime(10 * 60_000 - 2_000)
    await manager.getSession()

    expect(mockedSleep).toHaveBeenCalledTimes(1)
    expect(mockedSleep).toHaveBeenCalledWith(2_000, undefined)
    expect(messagesAt(log, 'debug').join('\n')).toMatch(/deferring re-authentication for 2s/)
  })

  it('does not defer a sign-in once the floor has already elapsed', async () => {
    const manager = createManager()
    await manager.getSession()
    manager.invalidate()

    jest.advanceTimersByTime(10 * 60_000 + 1)
    await manager.getSession()

    expect(mockedSleep).not.toHaveBeenCalled()
  })

  it('forgets the session and rethrows when the credentials are rejected', async () => {
    const manager = createManager()
    mockedAuthenticate.mockRejectedValue(new AuthenticationError())

    await expect(manager.getSession()).rejects.toThrow(AuthenticationError)
    expect(manager.hasSession).toBe(false)
    expect(messagesAt(log, 'error').join('\n')).toMatch(/Fix them before restarting/)
  })

  it('says plainly what to do about a two-factor challenge', async () => {
    const manager = createManager()
    mockedAuthenticate.mockRejectedValue(new TwoFactorRequiredError())

    await expect(manager.getSession()).rejects.toThrow(TwoFactorRequiredError)
    expect(messagesAt(log, 'error').join('\n')).toMatch(/Copy a fresh "twoFactorAuthenticationId" cookie/)
  })

  it('does not editorialise about a transient failure', async () => {
    const manager = createManager()
    mockedAuthenticate.mockRejectedValue(new Error('socket hang up'))

    await expect(manager.getSession()).rejects.toThrow('socket hang up')
    expect(log.error).not.toHaveBeenCalled()
  })

  /**
   * A transient failure gets a short floor rather than none.
   *
   * With no floor at all, a retryable sign-in failure let the very next caller
   * try again with nothing pacing it — and because sign-in bypasses the request
   * rate limiter, one API call could become six login attempts. The floor is
   * kept short so a boot-time blip still recovers on the next poll rather than
   * waiting out the whole re-authentication interval.
   */
  it('paces a retry briefly after a transient sign-in failure, then allows it', async () => {
    const manager = createManager()
    mockedAuthenticate.mockRejectedValueOnce(new Error('socket hang up'))

    await expect(manager.getSession()).rejects.toThrow('socket hang up')
    await expect(manager.getSession()).resolves.toBeDefined()

    expect(mockedSleep).toHaveBeenCalledTimes(1)
    expect(mockedSleep).toHaveBeenCalledWith(3_000, undefined)
    expect(mockedAuthenticate).toHaveBeenCalledTimes(2)
  })

  /**
   * The short failure floor must not become the long one. A transient failure
   * that waited out the full re-authentication interval would leave HomeKit
   * stale for ten minutes over a dropped packet.
   */
  it('does not apply the full re-authentication floor to a transient failure', async () => {
    const manager = createManager()
    mockedAuthenticate.mockRejectedValueOnce(new Error('socket hang up'))

    await expect(manager.getSession()).rejects.toThrow('socket hang up')
    jest.advanceTimersByTime(3_001)
    await expect(manager.getSession()).resolves.toBeDefined()

    expect(mockedSleep).not.toHaveBeenCalled()
  })

  /**
   * A rejected password is not a throttle, and reporting it as one leaves the
   * user with nothing to act on once the single original error has scrolled
   * away. The floor still applies; only the diagnosis is preserved.
   */
  it('keeps re-raising a credential rejection while the login floor holds', async () => {
    const manager = createManager()
    mockedAuthenticate
      .mockRejectedValueOnce(new AuthenticationError())
      .mockResolvedValue(aSession())

    await expect(manager.getSession()).rejects.toThrow(AuthenticationError)
    await expect(manager.getSession()).rejects.toThrow(AuthenticationError)

    expect(mockedAuthenticate).toHaveBeenCalledTimes(1)
    expect(mockedSleep).not.toHaveBeenCalled()
  })

  it('signs in again once the floor after a credential rejection has elapsed', async () => {
    const manager = createManager()
    mockedAuthenticate
      .mockRejectedValueOnce(new AuthenticationError())
      .mockResolvedValue(aSession())

    await expect(manager.getSession()).rejects.toThrow(AuthenticationError)
    jest.advanceTimersByTime(10 * 60_000 + 1)

    await expect(manager.getSession()).resolves.toBeDefined()
    expect(mockedAuthenticate).toHaveBeenCalledTimes(2)
  })

  describe('touch', () => {
    it('holds the session open without signing in again', async () => {
      const manager = createManager()
      const session = await manager.getSession()

      await expect(manager.touch()).resolves.toBe(true)

      expect(mockedKeepAlive).toHaveBeenCalledWith(session, undefined)
      expect(mockedAuthenticate).toHaveBeenCalledTimes(1)
    })

    it('does nothing when there is no session to hold open', async () => {
      await expect(createManager().touch()).resolves.toBe(false)
      expect(mockedKeepAlive).not.toHaveBeenCalled()
    })

    /**
     * The reason the keep-alive exists. Freshness used to be measured from the
     * login, which the keep-alive never updated, so it re-authenticated on the
     * auth interval regardless of how healthy the session was — spending a
     * request every four minutes to prevent nothing.
     */
    it('pushes back the next sign-in, which is the whole point of it', async () => {
      const manager = createManager()
      await manager.getSession()

      jest.advanceTimersByTime(8 * 60_000)
      await expect(manager.touch()).resolves.toBe(true)

      jest.advanceTimersByTime(8 * 60_000)
      await manager.getSession()

      expect(mockedAuthenticate).toHaveBeenCalledTimes(1)
    })

    it('still re-authenticates once a session goes unverified for too long', async () => {
      const manager = createManager()
      await manager.getSession()
      mockedKeepAlive.mockRejectedValue(new Error('socket hang up'))

      jest.advanceTimersByTime(10 * 60_000 + 1)
      await manager.getSession()

      expect(mockedAuthenticate).toHaveBeenCalledTimes(2)
    })

    it('drops the session when Alarm.com says it is no longer valid', async () => {
      const manager = createManager()
      await manager.getSession()
      mockedKeepAlive.mockResolvedValue(false)

      await expect(manager.touch()).resolves.toBe(false)
      expect(manager.hasSession).toBe(false)
    })

    it('does not wipe a newer session that replaced the one keep-alive probed', async () => {
      const manager = createManager()
      const first = await manager.getSession()
      // Step past the login floor so the re-login below is the thing under
      // test rather than the floor refusing it.
      jest.advanceTimersByTime(10 * 60_000 + 1)

      let finishKeepAlive!: (alive: boolean) => void
      mockedKeepAlive.mockImplementation(() => new Promise((resolve) => {
        finishKeepAlive = resolve
      }))

      const touchPromise = manager.touch()
      manager.invalidate()
      mockedAuthenticate.mockImplementation(() => Promise.resolve(aSession()))
      const second = await manager.getSession()

      finishKeepAlive(false)
      await expect(touchPromise).resolves.toBe(false)

      expect(second).not.toBe(first)
      expect(manager.hasSession).toBe(true)
      await expect(manager.getSession()).resolves.toBe(second)
      expect(mockedAuthenticate).toHaveBeenCalledTimes(2)
    })

    it('tolerates a single keep-alive transport failure without discarding the session', async () => {
      const manager = createManager()
      await manager.getSession()
      mockedKeepAlive.mockRejectedValueOnce(new Error('socket hang up'))

      await expect(manager.touch()).resolves.toBe(false)
      expect(manager.hasSession).toBe(true)
      expect(messagesAt(log, 'warn')).toHaveLength(0)
    })

    it('discards the session after repeated keep-alive transport failures', async () => {
      const manager = createManager()
      await manager.getSession()
      mockedKeepAlive.mockRejectedValue(new Error('socket hang up'))

      await expect(manager.touch()).resolves.toBe(false)
      await expect(manager.touch()).resolves.toBe(false)
      await expect(manager.touch()).resolves.toBe(false)

      expect(manager.hasSession).toBe(false)
      expect(messagesAt(log, 'warn').join('\n')).toMatch(/keep-alive failed repeatedly/)
    })
  })

  describe('invalidate', () => {
    it('forces the next caller to sign in again', async () => {
      const manager = createManager()
      await manager.getSession()

      manager.invalidate()

      expect(manager.hasSession).toBe(false)
      jest.advanceTimersByTime(10 * 60_000 + 1)
      await manager.getSession()
      expect(mockedAuthenticate).toHaveBeenCalledTimes(2)
    })
  })
})
