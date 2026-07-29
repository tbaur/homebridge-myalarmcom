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
 * Open-circuit and other retryable/transient conditions are debug: they are
 * already being handled (backoff, discovery retry). Credential and config
 * problems are error so they surface at default Homebridge log levels.
 */
export declare function failureLogLevel(error: unknown): 'debug' | 'error';
//# sourceMappingURL=failure-log-level.d.ts.map