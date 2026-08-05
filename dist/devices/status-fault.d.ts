/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Shared StatusFault handling for every accessory kind.
 */
import type { Characteristic, Service } from 'homebridge';
/**
 * Publish Alarm.com's malfunction flag as HomeKit's `StatusFault`.
 *
 * Note the `=== true`: the flag is absent on some payloads, and "we do not
 * know" is not the same as "healthy" — but HomeKit has no third value, so the
 * choice is made once here rather than re-argued at each call site.
 */
export declare function applyStatusFault(service: Service, characteristic: typeof Characteristic, isMalfunctioning: boolean | undefined): void;
//# sourceMappingURL=status-fault.d.ts.map