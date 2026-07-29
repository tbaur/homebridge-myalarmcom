/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Rejection capture for tests that assert on an error's contents rather than
 * only on its type.
 */

/** Await a promise expected to reject and hand back what it threw. */
export async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  let resolved: unknown

  try {
    resolved = await promise
  } catch (error) {
    return error as Error
  }

  throw new Error(`Expected a rejection but the promise resolved with ${String(resolved)}`)
}
