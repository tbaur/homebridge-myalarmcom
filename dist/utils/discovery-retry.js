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
 * Delay before retrying initial discovery, or `null` if the failure is permanent.
 *
 * {@link CircuitBreakerError} is not retryable inside a single API call (fail-fast),
 * but at startup it means "wait for the reset" rather than abandon Ready forever.
 */
function initialDiscoveryRetryDelayMs(error, attempt) {
    if (error instanceof errors_1.CircuitBreakerError) {
        return Math.max(error.retryAfterMs, settings_1.INITIAL_DISCOVERY_RETRY_BASE_MS);
    }
    if (error instanceof errors_1.AlarmComError && error.isRetryable) {
        return (0, retry_1.computeBackoffMs)(attempt, settings_1.INITIAL_DISCOVERY_RETRY_BASE_MS, settings_1.INITIAL_DISCOVERY_RETRY_MAX_MS);
    }
    return null;
}
//# sourceMappingURL=discovery-retry.js.map