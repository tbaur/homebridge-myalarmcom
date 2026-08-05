/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Shared "log only when it changed" policy for accessories.
 */

import type { Logger } from '../utils/logger'

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
export function createChangeLogger(log: Logger): (name: string, label: string) => void {
  let lastLabel: string | null = null

  return (name, label) => {
    const isChange = lastLabel !== null && lastLabel !== label
    lastLabel = label

    if (isChange) {
      log.info(`${name}: ${label}`)
    } else if (log.isDebugEnabled) {
      log.debug(`${name}: ${label}`)
    }
  }
}
