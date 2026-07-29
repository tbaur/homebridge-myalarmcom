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
    readonly client: AlarmComClient;
    constructor(log: Logging, config: MyAlarmComPlatformConfig, api: API);
    /** Homebridge replays cached accessories here on startup. */
    configureAccessory(accessory: PlatformAccessory): void;
    /**
     * Schedule a targeted refresh of one device.
     *
     * Calls are coalesced over a short window because a single physical action
     * (a door opening) often produces several stream frames.
     */
    requestDeviceRefresh(deviceId: string): void;
}
//# sourceMappingURL=platform.d.ts.map