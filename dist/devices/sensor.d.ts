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
import type { Resource, SensorAttributes, SensorServiceKind } from '../types/alarm';
import type { Logger } from '../utils/logger';
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
     * Republish the name when Alarm.com reports a different one.
     *
     * The constructor sets it once and does not re-run for an existing handler, so
     * a sensor renamed at the panel kept its old HomeKit name until Homebridge
     * restarted. Tracking it here also keeps the push and poll log lines using the
     * same name — they previously read from different sources and could disagree.
     */
    updateName(displayName: string): void;
    /** Release any timer this accessory owns, so shutdown is clean. */
    dispose(): void;
    /**
     * Publish a state inferred from a push event, ahead of the confirming read.
     *
     * This exists so a door that is opened and shut within a second or two still
     * registers in HomeKit. The re-read that follows is authoritative and will
     * correct this value, so the cost of being wrong here is a brief flicker
     * rather than a persistently wrong state.
     *
     * @param isTransient The event already implies a return to rest, so the pulse
     *   is cleared on a timer if the confirming read never lands. Without that,
     *   a failed re-read leaves a door that has already shut showing open until
     *   the next poll — up to a day at the maximum poll interval.
     */
    applyImmediateState(isTriggered: boolean, isTransient?: boolean): void;
    /**
     * Push a fresh Alarm.com reading into HomeKit.
     *
     * An unmappable device type leaves the previous value in place rather than
     * substituting a default, so a sensor never quietly reports "all clear"
     * because its type was unrecognised.
     */
    update(resource: Resource<SensorAttributes>): void;
}
//# sourceMappingURL=sensor.d.ts.map