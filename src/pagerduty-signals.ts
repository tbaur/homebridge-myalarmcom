import { closeSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import type * as Sqlite from 'node:sqlite'

export type SignalSeverity = 'info' | 'warning' | 'error' | 'critical'

export interface SignalState {
  active: boolean
  severity: SignalSeverity
  summary: string
}

export interface PagerDutySignalsOptions {
  /** This plugin's npm package name, exactly as in package.json. */
  plugin: string
  /** `api.user.storagePath()` */
  storagePath: string
  log: { warn(message: string): void }
}

const STORE_DIR = 'homebridge-pagerduty'
// The signal store interface this module writes. Change it only by copying a
// newer version of this module from homebridge-pagerduty's docs/SIGNALS-AGENT.md.
const INTERFACE_ID = 'signals-2026-10-24'
const STORE_FILE = 'signals.sqlite'
const MAX_SUMMARY_LENGTH = 1024
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]+/g

// The table definition of interface signals-2026-10-24. Every writer must run
// this exact text: the first process to run it defines the table.
const SCHEMA = `PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS signals (
  plugin     TEXT    NOT NULL CHECK (length(plugin) BETWEEN 1 AND 128 AND plugin NOT GLOB '*[^a-z0-9@/._-]*'),
  signal     TEXT    NOT NULL CHECK (length(signal) BETWEEN 1 AND 64 AND signal NOT GLOB '*[^a-z0-9._-]*'),
  active     INTEGER NOT NULL CHECK (active IN (0, 1)),
  severity   TEXT    NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  summary    TEXT    NOT NULL CHECK (length(summary) BETWEEN 1 AND 1024),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (plugin, signal)
) STRICT;`

const UPSERT = 'INSERT INTO signals (plugin, signal, active, severity, summary, updated_at) VALUES (?, ?, ?, ?, ?, ?) '
  + 'ON CONFLICT (plugin, signal) DO UPDATE SET active = excluded.active, severity = excluded.severity, '
  + 'summary = excluded.summary, updated_at = excluded.updated_at'

/**
 * Writes this plugin's conditions to the homebridge-pagerduty signal store.
 * Never throws: a failure is logged once, and the next write tries again.
 */
export class PagerDutySignals {
  private readonly options: PagerDutySignalsOptions
  private db: Sqlite.DatabaseSync | undefined
  private readonly lastWritten = new Map<string, string>()
  private isDisabled = false
  private hasWarned = false

  constructor(options: PagerDutySignalsOptions) {
    this.options = options
  }

  /** Record a signal's current state. Skipped when nothing changed since the last write. */
  write(signal: string, state: SignalState): void {
    const summary = state.summary.replace(CONTROL_CHARACTERS, ' ').slice(0, MAX_SUMMARY_LENGTH)
    const fingerprint = `${state.active ? 1 : 0}|${state.severity}|${summary}`
    if (this.isDisabled || this.lastWritten.get(signal) === fingerprint) {
      return
    }
    try {
      const db = this.db ?? this.open()
      db.prepare(UPSERT).run(this.options.plugin, signal, state.active ? 1 : 0, state.severity, summary, Date.now())
      this.lastWritten.set(signal, fingerprint)
      this.hasWarned = false
    } catch (error) {
      this.warnOnce(`PagerDuty signal ${signal} was not written: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Close the connection. Call on Homebridge `shutdown`. Never clears a signal. */
  close(): void {
    this.db?.close()
    this.db = undefined
  }

  private open(): Sqlite.DatabaseSync {
    // Loaded here, not imported at the top, so the plugin still loads on a
    // Node version without node:sqlite.
    const sqlite = typeof process.getBuiltinModule === 'function'
      ? process.getBuiltinModule('node:sqlite') as typeof Sqlite | undefined
      : undefined
    if (sqlite === undefined) {
      this.disable('PagerDuty signals need Node 22.13 or later; not writing signals')
    }
    const dir = join(this.options.storagePath, STORE_DIR, INTERFACE_ID)
    const file = join(dir, STORE_FILE)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    closeSync(openSync(file, 'a', 0o600))
    const db = new sqlite.DatabaseSync(file)
    try {
      db.exec('PRAGMA busy_timeout = 1000')
      db.exec(SCHEMA)
    } catch (error) {
      db.close()
      throw error
    }
    this.db = db
    return db
  }

  private disable(message: string): never {
    this.isDisabled = true
    this.hasWarned = false
    this.warnOnce(message)
    throw new Error(message)
  }

  private warnOnce(message: string): void {
    if (!this.hasWarned) {
      this.hasWarned = true
      this.options.log.warn(message)
    }
  }
}
