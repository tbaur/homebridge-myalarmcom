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
    /** Push fresh partition attributes into HomeKit. */
    update(resource: Resource<PartitionAttributes>): void;
}
//# sourceMappingURL=partition.d.ts.map