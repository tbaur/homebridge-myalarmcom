/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Security panel accessory.
 */
import { type PlatformAccessory } from 'homebridge';
import { type PartitionAttributes, type Resource } from '../types/alarm';
import type { Logger } from '../utils/logger';
import type { MyAlarmComPlatform } from '../platform';
/** What the platform stores on a partition accessory between restarts. */
export interface PartitionAccessoryContext {
    deviceId: string;
    kind: 'partition';
    displayName: string;
}
/** A HomeKit security system backed by one Alarm.com partition. */
export declare class PartitionAccessory {
    #private;
    constructor(platform: MyAlarmComPlatform, accessory: PlatformAccessory, log: Logger);
    get deviceId(): string;
    /**
     * Republish the name when Alarm.com reports a different one.
     *
     * The constructor sets it once, and the constructor does not re-run for an
     * existing handler — so a device renamed at the panel kept its old HomeKit
     * name until Homebridge restarted, even though the platform was already
     * writing the new one into the accessory context.
     */
    updateName(displayName: string): void;
    /** Push fresh partition attributes into HomeKit. */
    update(resource: Resource<PartitionAttributes>): void;
}
//# sourceMappingURL=partition.d.ts.map