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
import { AuthenticationError, TwoFactorRequiredError } from '../../../src/errors'
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

function sessionAt(createdAt = new Date()): Session {
  return { cookieHeader: 'afg=csrf-value', ajaxKey: 'csrf-value', createdAt }
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
    mockedAuthenticate.mockImplementation(() => Promise.resolve(sessionAt()))
    mockedKeepAlive.mockResolvedValue(true)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('signs in on the first request for a session', async () => {
    const manager = createManager()

    const session = await manager.getSession()

    expect(session.ajaxKey).toBe('csrf-value')
    expect(mockedAuthenticate).toHaveBeenCalledWith(CREDENTIALS, log)
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

  it('waits out the login floor rather than signing in back to back', async () => {
    const manager = createManager()
    await manager.getSession()
    manager.invalidate()

    jest.advanceTimersByTime(60_000)
    await manager.getSession()

    expect(mockedSleep).toHaveBeenCalledTimes(1)
    expect(mockedSleep).toHaveBeenCalledWith(10 * 60_000 - 60_000)
    expect(messagesAt(log, 'debug').join('\n')).toMatch(/deferring re-authentication for 540s/)
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

  it('lets a later caller try again immediately after a transient sign-in failure', async () => {
    const manager = createManager()
    mockedAuthenticate.mockRejectedValueOnce(new Error('socket hang up'))

    await expect(manager.getSession()).rejects.toThrow('socket hang up')
    await expect(manager.getSession()).resolves.toBeDefined()

    expect(mockedSleep).not.toHaveBeenCalled()
    expect(mockedAuthenticate).toHaveBeenCalledTimes(2)
  })

  it('starts the login floor after a permanent credential rejection', async () => {
    const manager = createManager()
    mockedAuthenticate
      .mockRejectedValueOnce(new AuthenticationError())
      .mockResolvedValue(sessionAt())

    await expect(manager.getSession()).rejects.toThrow(AuthenticationError)
    await expect(manager.getSession()).resolves.toBeDefined()

    expect(mockedSleep).toHaveBeenCalledTimes(1)
    expect(mockedSleep).toHaveBeenCalledWith(10 * 60_000)
  })

  describe('touch', () => {
    it('holds the session open without signing in again', async () => {
      const manager = createManager()
      const session = await manager.getSession()

      await expect(manager.touch()).resolves.toBe(true)

      expect(mockedKeepAlive).toHaveBeenCalledWith(session)
      expect(mockedAuthenticate).toHaveBeenCalledTimes(1)
    })

    it('does nothing when there is no session to hold open', async () => {
      await expect(createManager().touch()).resolves.toBe(false)
      expect(mockedKeepAlive).not.toHaveBeenCalled()
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

      let finishKeepAlive!: (alive: boolean) => void
      mockedKeepAlive.mockImplementation(() => new Promise((resolve) => {
        finishKeepAlive = resolve
      }))

      const touchPromise = manager.touch()
      manager.invalidate()
      mockedAuthenticate.mockImplementation(() => Promise.resolve(sessionAt(new Date())))
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
      await manager.getSession()
      expect(mockedAuthenticate).toHaveBeenCalledTimes(2)
    })
  })
})
