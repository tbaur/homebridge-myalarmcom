/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Helpers for reading captured Alarm.com fixtures.
 */

/**
 * The entry at an index, failing loudly if the fixture no longer has one.
 *
 * `noUncheckedIndexedAccess` types every fixture lookup as possibly undefined,
 * which is correct: a fixture that has been re-captured and lost a device
 * should fail with a message naming the fixture, not with a null dereference
 * three assertions later.
 */
export function fixtureAt<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index]
  if (item === undefined) {
    throw new Error(`The ${what} fixture has no entry at index ${index}`)
  }
  return item
}
