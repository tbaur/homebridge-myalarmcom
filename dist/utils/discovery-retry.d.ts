/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Retry policy for the platform's initial device discovery.
 */
/**
 * Delay before retrying initial discovery, or `null` if the failure is permanent.
 *
 * {@link CircuitBreakerError} is not retryable inside a single API call (fail-fast),
 * but at startup it means "wait for the reset" rather than abandon Ready forever.
 */
export declare function initialDiscoveryRetryDelayMs(error: unknown, attempt: number): number | null;
//# sourceMappingURL=discovery-retry.d.ts.map