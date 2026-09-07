/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Shared "log only when it changed" policy for accessories.
 */

import type { Logger } from '../utils/logger'

/** Reports readings that differ from the last one, and accepts silent updates. */
export interface ChangeLogger {
  /** Log this reading, at info if it differs from the previous one. */
  report: (name: string, label: string) => void
  /**
   * Record a reading as already reported, without logging it.
   *
   * For when a state change has been announced by other means and the confirming
   * poll would otherwise repeat it. Calling {@link report} to prime the state
   * emitted the very line it was trying to suppress, so a command that succeeded
   * logged its outcome twice.
   */
  markReported: (label: string) => void
}

/**
 * Build a logger that reports a reading at info only when it differs from the
 * last one.
 *
 * Polling re-reads every device on every cycle, so logging each reading at info
 * would be thousands of identical lines a day. The first reading is debug too:
 * at startup every device reports for the first time, and that is not news.
 *
 * Shared because partition and sensor implement the same policy, and a change to
 * it should not have to be made twice.
 */
export function createChangeLogger(log: Logger): ChangeLogger {
  let lastLabel: string | null = null

  return {
    report(name, label) {
      const isChange = lastLabel !== null && lastLabel !== label
      lastLabel = label

      if (isChange) {
        log.info(`${name}: ${label}`)
      } else if (log.isDebugEnabled) {
        log.debug(`${name}: ${label}`)
      }
    },

    markReported(label) {
      lastLabel = label
    },
  }
}
