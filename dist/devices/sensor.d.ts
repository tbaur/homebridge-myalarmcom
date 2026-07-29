/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Contact, motion, and smoke sensor accessories.
 *
 * One class covers all three because they differ only in which HomeKit service
 * they publish and which characteristic carries the reading. The state
 * resolution behind them is identical.
 */
import type { PlatformAccessory } from 'homebridge';
import type { Resource, SensorAttributes } from '../types/alarm';
import type { Logger } from '../utils/logger';
import { type SensorServiceKind } from '../utils/mappers';
import type { MyAlarmComPlatform } from '../platform';
/** What the platform stores on a sensor accessory between restarts. */
export interface SensorAccessoryContext {
    deviceId: string;
    kind: SensorServiceKind;
    displayName: string;
}
/** A HomeKit accessory backed by one Alarm.com sensor. */
export declare class SensorAccessory {
    #private;
    constructor(platform: MyAlarmComPlatform, accessory: PlatformAccessory, kind: SensorServiceKind, log: Logger);
    get deviceId(): string;
    /** The device type established at discovery, which push frames misreport. */
    get kind(): SensorServiceKind;
    /**
     * Publish a state inferred from a push event, ahead of the confirming read.
     *
     * This exists so a door that is opened and shut within a second or two still
     * registers in HomeKit. The re-read that follows is authoritative and will
     * correct this value, so the cost of being wrong here is a brief flicker
     * rather than a persistently wrong state.
     */
    applyImmediateState(isTriggered: boolean): void;
    /**
     * Push a fresh Alarm.com reading into HomeKit.
     *
     * An unmappable reading leaves the previous value in place rather than
     * substituting a default, so a sensor never quietly reports "all clear"
     * because its state was unrecognised.
     */
    update(resource: Resource<SensorAttributes>): void;
}
//# sourceMappingURL=sensor.d.ts.map