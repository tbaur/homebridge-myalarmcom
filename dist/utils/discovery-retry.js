"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Retry policy for the platform's initial device discovery.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.initialDiscoveryRetryDelayMs = initialDiscoveryRetryDelayMs;
const errors_1 = require("../errors");
const settings_1 = require("../settings");
const retry_1 = require("./retry");
/**
 * Whether a startup failure will still be there after any amount of waiting.
 *
 * Only failures that need a human: wrong credentials, an expired two-factor
 * cookie, a login page this plugin can no longer parse, or invalid config.
 * Everything else — including a 403, which Alarm.com hands out transiently —
 * gets retried, because giving up leaves a security integration silently dead
 * with no polling, no push updates, and one line in the log.
 */
function isPermanent(error) {
    return error instanceof errors_1.AuthenticationError
        || error instanceof errors_1.LoginFormError
        || error instanceof errors_1.ConfigurationError;
}
/**
 * Delay before retrying initial discovery, or `null` if the failure is permanent.
 *
 * {@link CircuitBreakerError} is not retryable inside a single API call (fail-fast),
 * but at startup it means "wait for the reset" rather than abandon Ready forever.
 */
function initialDiscoveryRetryDelayMs(error, attempt) {
    if (isPermanent(error)) {
        return null;
    }
    if (error instanceof errors_1.CircuitBreakerError) {
        return Math.max(error.retryAfterMs, settings_1.INITIAL_DISCOVERY_RETRY_BASE_MS);
    }
    if (error instanceof errors_1.AlarmComError) {
        return (0, retry_1.computeBackoffMs)(attempt, settings_1.INITIAL_DISCOVERY_RETRY_BASE_MS, settings_1.INITIAL_DISCOVERY_RETRY_MAX_MS);
    }
    // Not one of ours: almost certainly a defect rather than a service condition,
    // and retrying a bug on a loop only buries the stack trace that explains it.
    return null;
}
//# sourceMappingURL=discovery-retry.js.map