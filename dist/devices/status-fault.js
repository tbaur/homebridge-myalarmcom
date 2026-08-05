"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Shared StatusFault handling for every accessory kind.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyStatusFault = applyStatusFault;
/**
 * Publish Alarm.com's malfunction flag as HomeKit's `StatusFault`.
 *
 * Note the `=== true`: the flag is absent on some payloads, and "we do not
 * know" is not the same as "healthy" — but HomeKit has no third value, so the
 * choice is made once here rather than re-argued at each call site.
 */
function applyStatusFault(service, characteristic, isMalfunctioning) {
    service.updateCharacteristic(characteristic.StatusFault, isMalfunctioning === true
        ? characteristic.StatusFault.GENERAL_FAULT
        : characteristic.StatusFault.NO_FAULT);
}
//# sourceMappingURL=status-fault.js.map