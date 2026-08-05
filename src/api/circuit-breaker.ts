/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Circuit breaker for API resilience.
 *
 * Beyond the usual benefit of not hammering a service that is already failing,
 * this has a specific purpose here: Alarm.com locks accounts that generate
 * sustained failing traffic, and a locked account takes down the alarm panel's
 * own app access. Failing fast protects the user's account, not just the plugin.
 */

import { CircuitBreakerError } from '../errors'
import { MS_PER_MINUTE, MS_PER_SECOND } from '../settings'

/** Circuit breaker states. */
export enum CircuitState {
  /** Normal operation; requests flow through. */
  CLOSED = 'CLOSED',
  /** Tripped; requests fail immediately. */
  OPEN = 'OPEN',
  /** Probing whether the service recovered. */
  HALF_OPEN = 'HALF_OPEN',
}

/** Circuit breaker tuning. */
export interface CircuitBreakerConfig {
  /** Failures within the window before the circuit opens. */
  failureThreshold: number
  /** How long to stay open before probing again, in ms. */
  resetTimeoutMs: number
  /** Consecutive successes needed to close from half-open. */
  successesToClose: number
  /** Concurrent probes admitted while half-open. */
  halfOpenProbes: number
  /** Sliding window over which failures are counted, in ms. */
  failureWindowMs: number
  /**
   * Window within which consecutive failures count as one.
   *
   * One logical request retries a few times within a couple of seconds; that is
   * one failure of one request, not three independent signals about the service.
   */
  failureCoalesceMs: number
  /** Called on every state transition, for observability. */
  onStateChange?: (from: CircuitState, to: CircuitState) => void
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 30 * MS_PER_SECOND,
  successesToClose: 3,
  halfOpenProbes: 3,
  /**
   * Deliberately several poll intervals wide.
   *
   * A poll cycle contributes one coalesced failure per failing request. With a
   * window equal to the default 60-second poll interval, a cycle's failures
   * always aged out before the next tick, so the breaker could never reach its
   * threshold and a total Alarm.com outage produced no `CLOSED -> OPEN` warning
   * at all — the one line a polling-only deployment would otherwise see.
   */
  failureWindowMs: 5 * MS_PER_MINUTE,
  /**
   * Wide enough to absorb one request's retries when they fail *fast*.
   *
   * `MAX_API_RETRY_ATTEMPTS` attempts with jittered backoff from 1s, plus the 1s
   * pacing gap between them, fits inside this — which covers the case this
   * exists for: a 4xx or a refused connection retried three times is one signal
   * about the service, not three.
   *
   * It deliberately does *not* cover a request that fails by timing out, since
   * three 30s timeouts span longer than any sane coalescing window. Those still
   * count separately, and that is the right direction: a service that accepts
   * connections and then never answers should open the breaker sooner than one
   * returning fast errors, not later.
   */
  failureCoalesceMs: 15 * MS_PER_SECOND,
}

/**
 * Snapshot of breaker state, for diagnostics.
 *
 * Trimmed to what is consumed. It previously carried `failures`, `successes`,
 * `lastFailureTime` and `isOpen`, all computed on every diagnostics heartbeat
 * and read by nothing.
 */
export interface CircuitBreakerStatus {
  state: CircuitState
  /** Failures inside the sliding window, one per logical request. */
  failures: number
  /** How long until a probe is admitted, or `null` when one already would be. */
  remainingResetTimeMs: number | null
}

/** Circuit breaker guarding calls to Alarm.com. */
export class CircuitBreaker {
  readonly #failureThreshold: number
  readonly #resetTimeoutMs: number
  readonly #successesToClose: number
  readonly #halfOpenProbes: number
  readonly #failureWindowMs: number
  readonly #failureCoalesceMs: number
  #onStateChange: ((from: CircuitState, to: CircuitState) => void) | undefined

  #state: CircuitState = CircuitState.CLOSED
  #successes = 0
  #lastFailureTime: number | null = null
  #halfOpenRequests = 0
  #failureTimestamps: number[] = []

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    const merged = { ...DEFAULT_CIRCUIT_BREAKER_CONFIG, ...config }
    this.#failureThreshold = merged.failureThreshold
    this.#resetTimeoutMs = merged.resetTimeoutMs
    this.#successesToClose = merged.successesToClose
    this.#halfOpenProbes = merged.halfOpenProbes
    this.#failureWindowMs = merged.failureWindowMs
    this.#failureCoalesceMs = merged.failureCoalesceMs
    this.#onStateChange = merged.onStateChange
  }

  /**
   * Chain an additional state-change listener (e.g. client logging) without
   * replacing any listener already supplied at construction.
   */
  attachOnStateChange(handler: (from: CircuitState, to: CircuitState) => void): void {
    const previous = this.#onStateChange
    this.#onStateChange = (from, to) => {
      previous?.(from, to)
      handler(from, to)
    }
  }


  /** Whether the breaker is currently rejecting requests outright. */
  get isOpen(): boolean {
    return this.#state === CircuitState.OPEN
  }

  /** Transition state, notifying observers only on an actual change. */
  #transitionTo(next: CircuitState): void {
    if (this.#state === next) {
      return
    }
    const previous = this.#state
    this.#state = next
    this.#onStateChange?.(previous, next)
  }

  /** Drop failures that have aged out of the sliding window. */
  #pruneFailures(): void {
    const cutoff = Date.now() - this.#failureWindowMs
    this.#failureTimestamps = this.#failureTimestamps.filter((ts) => ts > cutoff)
  }

  /** Whether a request may proceed right now. */
  canRequest(): boolean {
    if (this.#state === CircuitState.CLOSED) {
      return true
    }

    if (this.#state === CircuitState.OPEN) {
      const isCooldownElapsed = this.#lastFailureTime !== null
        && Date.now() - this.#lastFailureTime >= this.#resetTimeoutMs

      if (isCooldownElapsed) {
        this.#halfOpenRequests = 0
        this.#successes = 0
        this.#transitionTo(CircuitState.HALF_OPEN)
        return true
      }
      return false
    }

    return this.#halfOpenRequests < this.#halfOpenProbes
  }

  /** Note that a guarded call succeeded, closing the circuit once enough have. */
  recordSuccess(): void {
    if (this.#state === CircuitState.HALF_OPEN) {
      this.#successes++
      if (this.#successes >= this.#successesToClose) {
        this.reset()
      }
      return
    }
    this.#pruneFailures()
  }

  /**
   * Note that a guarded call failed, opening the circuit once enough have.
   *
   * Deduplicated within `#failureCoalesceMs`. One logical request is up to
   * `MAX_API_RETRY_ATTEMPTS` guarded calls landing within a few seconds, so
   * counting each separately meant two isolated flaky requests anywhere in the
   * window tripped a breaker configured for five failures — however many
   * hundreds of requests had succeeded in between.
   */
  recordFailure(): void {
    const now = Date.now()
    const previous = this.#failureTimestamps[this.#failureTimestamps.length - 1]
    const isSameBurst = previous !== undefined && now - previous < this.#failureCoalesceMs

    this.#lastFailureTime = now
    if (!isSameBurst) {
      this.#failureTimestamps.push(now)
    }

    if (this.#state === CircuitState.HALF_OPEN) {
      // Any failure while probing means the service is still unwell.
      this.#halfOpenRequests = 0
      this.#successes = 0
      this.#transitionTo(CircuitState.OPEN)
      return
    }

    if (this.#state === CircuitState.CLOSED) {
      this.#pruneFailures()
      if (this.#failureTimestamps.length >= this.#failureThreshold) {
        this.#transitionTo(CircuitState.OPEN)
      }
    }
  }

  /** Return to the closed state and forget all recorded failures. */
  reset(): void {
    this.#successes = 0
    this.#lastFailureTime = null
    this.#halfOpenRequests = 0
    this.#failureTimestamps = []
    this.#transitionTo(CircuitState.CLOSED)
  }

  /** How long until the breaker will admit a probe, or `null` if it already will. */
  #remainingResetTimeMs(): number | null {
    return this.#state === CircuitState.OPEN && this.#lastFailureTime !== null
      ? Math.max(0, this.#resetTimeoutMs - (Date.now() - this.#lastFailureTime))
      : null
  }

  /** Snapshot of breaker state, for diagnostics. */
  getStatus(): CircuitBreakerStatus {
    this.#pruneFailures()
    const remainingResetTimeMs = this.#remainingResetTimeMs()

    return {
      state: this.#state,
      failures: this.#failureTimestamps.length,
      remainingResetTimeMs,
    }
  }

  /**
   * Run an operation under the breaker.
   *
   * @throws {CircuitBreakerError} The circuit is open.
   */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.canRequest()) {
      throw new CircuitBreakerError(this.#remainingResetTimeMs() ?? this.#resetTimeoutMs)
    }

    const isProbe = this.#state === CircuitState.HALF_OPEN
    if (isProbe) {
      this.#halfOpenRequests++
    }

    try {
      const result = await operation()
      this.recordSuccess()
      return result
    } catch (error) {
      this.recordFailure()
      throw error
    } finally {
      // Released here rather than only in recordSuccess/recordFailure. Those
      // require the probe to settle, so a probe that never did left the counter
      // at its ceiling: canRequest() then refused every request forever, and
      // because the state was HALF_OPEN rather than OPEN the cooldown that
      // would have rescued it was never re-checked.
      if (isProbe) {
        this.#halfOpenRequests = Math.max(0, this.#halfOpenRequests - 1)
      }
    }
  }
}
