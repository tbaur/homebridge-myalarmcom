/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Chooses a log level for platform-reported Alarm.com failures.
 */
/**
 * Log level for a failure the user may or may not be able to act on.
 *
 * Open-circuit, forbidden (403), self-imposed pacing, and other
 * retryable/transient conditions are debug: they are already being handled
 * (backoff, circuit breaker, discovery retry). Credential and config problems
 * are error so they surface at default Homebridge log levels.
 *
 * Alarm.com 403s often clear without user action; the circuit breaker counts
 * them and logs CLOSED -> OPEN when access stays broken, so repeating "Poll
 * failed: 403" at error adds noise without a new remedy.
 *
 * This is a per-occurrence decision only. A failure that keeps happening is
 * escalated by the caller (see the platform's failure tracking), because a
 * sustained outage logged only at debug is invisible at default log levels.
 */
export declare function failureLogLevel(error: unknown): 'debug' | 'error';
//# sourceMappingURL=failure-log-level.d.ts.map