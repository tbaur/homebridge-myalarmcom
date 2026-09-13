/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Homebridge dynamic platform: discovery, state, and lifecycle.
 */
import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, Service } from 'homebridge';
import { AlarmComClient } from './api/client';
import type { MyAlarmComPlatformConfig } from './types/config';
/** Homebridge platform exposing Alarm.com partitions and sensors. */
export declare class MyAlarmComPlatform implements DynamicPlatformPlugin {
    #private;
    readonly Service: typeof Service;
    readonly Characteristic: typeof Characteristic;
    readonly api: API;
    constructor(log: Logging, config: MyAlarmComPlatformConfig, api: API);
    /**
     * The API client, used by accessories to issue commands.
     *
     * Only reachable once the configuration is usable: an unusable one publishes
     * no accessories, so there is nothing to call this.
     */
    get client(): AlarmComClient;
    /**
     * Whether an arming command may bypass sensors that are open.
     *
     * Exposed as a single flag rather than the whole configuration so an
     * accessory cannot quietly grow a dependency on unrelated settings.
     */
    get isSensorBypassAllowed(): boolean;
    /**
     * Whether HomeKit may arm or disarm the panel.
     *
     * On by default. Exposed as a single flag so an accessory cannot grow a
     * dependency on unrelated settings. HomeKit has no PIN prompt; turning this
     * off leaves the tile as a display of the panel's state.
     */
    get isHomeKitArmingAllowed(): boolean;
    /**
     * Names of contacts standing open, which a panel will not arm over.
     *
     * Empty when the account has more than one partition. Alarm.com reports
     * sensors per system, not per partition, so with several partitions there is
     * no way to tell whether an open door belongs to the one being armed, and
     * refusing on that basis would block an arm the panel would have accepted.
     *
     * Sorted so a message naming several of them reads the same way twice.
     */
    listOpenContacts(): string[];
    /** Homebridge replays cached accessories here on startup. */
    configureAccessory(accessory: PlatformAccessory): void;
    /** Record a HomeKit-originated arming command for diagnostics. */
    recordCommand(): void;
    /**
     * Schedule a targeted refresh of one device.
     *
     * Calls are coalesced over a short window because a single physical action
     * (a door opening) often produces several stream frames.
     */
    requestDeviceRefresh(deviceId: string): void;
}
//# sourceMappingURL=platform.d.ts.map