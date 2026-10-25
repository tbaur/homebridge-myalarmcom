/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview The copied signal-store writer, against a real SQLite file.
 */

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as Sqlite from 'node:sqlite'
import { PagerDutySignals } from '../../src/pagerduty-signals'

const sqlite = typeof process.getBuiltinModule === 'function'
  ? process.getBuiltinModule('node:sqlite') as typeof Sqlite | undefined
  : undefined
const describeWithSqlite = sqlite ? describe : describe.skip

const PLUGIN = 'homebridge-myalarmcom'

interface SignalRow {
  plugin: string
  signal: string
  active: number
  severity: string
  summary: string
  updated_at: number
}

describeWithSqlite('PagerDutySignals', () => {
  let storagePath: string
  let warn: jest.Mock
  let signals: PagerDutySignals

  const storeDir = (): string => join(storagePath, 'homebridge-pagerduty')
  const interfaceDir = (): string => join(storeDir(), 'signals-2026-10-24')
  const storeFile = (): string => join(interfaceDir(), 'signals.sqlite')

  const readRows = (): SignalRow[] => {
    const db = new sqlite!.DatabaseSync(storeFile())
    try {
      return db.prepare('SELECT * FROM signals ORDER BY signal').all() as unknown as SignalRow[]
    } finally {
      db.close()
    }
  }

  beforeEach(() => {
    storagePath = mkdtempSync(join(tmpdir(), 'myalarmcom-signals-'))
    warn = jest.fn()
    signals = new PagerDutySignals({ plugin: PLUGIN, storagePath, log: { warn } })
  })

  afterEach(() => {
    signals.close()
    rmSync(storagePath, { recursive: true, force: true })
  })

  it('creates both store directories with mode 0700 and the file with mode 0600', () => {
    signals.write('alarm-active', {
      active: false,
      severity: 'critical',
      summary: 'The security system is in alarm.',
    })

    expect(statSync(storeDir()).mode & 0o777).toBe(0o700)
    expect(statSync(interfaceDir()).mode & 0o777).toBe(0o700)
    expect(statSync(storeFile()).mode & 0o777).toBe(0o600)
  })

  it('writes a row that a separate connection reads back', () => {
    signals.write('auth-failed', {
      active: true,
      severity: 'error',
      summary: 'Alarm.com rejected the sign-in.',
    })

    expect(readRows()).toEqual([
      expect.objectContaining({
        plugin: PLUGIN,
        signal: 'auth-failed',
        active: 1,
        severity: 'error',
        summary: 'Alarm.com rejected the sign-in.',
      }),
    ])
  })

  it('does not rewrite a signal whose state has not changed', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000)
    signals.write('cloud-offline', {
      active: true,
      severity: 'error',
      summary: 'Homebridge has not reached Alarm.com.',
    })
    nowSpy.mockReturnValue(2_000)
    signals.write('cloud-offline', {
      active: true,
      severity: 'error',
      summary: 'Homebridge has not reached Alarm.com.',
    })

    expect(readRows()[0]?.updated_at).toBe(1_000)
  })

  it('stores a newline in a summary as a space', () => {
    signals.write('smoke-active', {
      active: true,
      severity: 'critical',
      summary: 'A smoke detector\nis active.',
    })

    expect(readRows()[0]?.summary).toBe('A smoke detector is active.')
  })

  it('leaves the row in place when the connection closes', () => {
    signals.write('alarm-active', {
      active: true,
      severity: 'critical',
      summary: 'The security system is in alarm.',
    })
    signals.close()

    expect(readRows()).toEqual([
      expect.objectContaining({ signal: 'alarm-active', active: 1 }),
    ])
  })

  it('creates nothing and warns once when node:sqlite is unavailable', () => {
    jest.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined)

    signals.write('cloud-offline', {
      active: true,
      severity: 'error',
      summary: 'Homebridge has not reached Alarm.com.',
    })
    signals.write('auth-failed', {
      active: true,
      severity: 'error',
      summary: 'Alarm.com rejected the sign-in.',
    })

    expect(existsSync(storeDir())).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Node 22.13'))
  })
})
