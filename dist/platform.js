"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Homebridge dynamic platform: discovery, state, and lifecycle.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MyAlarmComPlatform = void 0;
const client_1 = require("./api/client");
const event_stream_1 = require("./api/event-stream");
const session_manager_1 = require("./api/session-manager");
const partition_1 = require("./devices/partition");
const sensor_1 = require("./devices/sensor");
const errors_1 = require("./errors");
const settings_1 = require("./settings");
const events_1 = require("./types/events");
const logger_1 = require("./utils/logger");
const mappers_1 = require("./utils/mappers");
const sanitizers_1 = require("./utils/sanitizers");
const validators_1 = require("./utils/validators");
/** Window over which event-triggered refreshes are coalesced. */
const REFRESH_DEBOUNCE_MS = 750;
/** Homebridge platform exposing Alarm.com partitions and sensors. */
class MyAlarmComPlatform {
    Service;
    Characteristic;
    api;
    client;
    #log;
    #config;
    #cachedAccessories = new Map();
    #partitions = new Map();
    #sensors = new Map();
    #eventStream = null;
    #pollTimer = null;
    #keepAliveTimer = null;
    #refreshTimer = null;
    #pendingRefreshIds = new Set();
    #systemId = null;
    #isShuttingDown = false;
    /** When the account was last re-enumerated, driving periodic rediscovery. */
    #lastDiscoveryAt = 0;
    constructor(log, config, api) {
        this.api = api;
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;
        const { config: resolved, warnings } = (0, validators_1.validateConfig)(config);
        this.#config = resolved;
        this.#log = (0, logger_1.createScopedLogger)(log, 'platform', resolved.debug);
        // Routed through the scoped logger rather than the raw Homebridge one so
        // the "every line is redacted" guarantee holds without exception. Config
        // warnings quote user-supplied values, which is precisely where a
        // mistakenly pasted secret would surface.
        for (const warning of warnings) {
            this.#log.warn(warning);
        }
        const sessionManager = new session_manager_1.SessionManager({
            credentials: {
                username: resolved.username,
                password: resolved.password,
                twoFactorAuthenticationId: resolved.twoFactorAuthenticationId,
            },
            authIntervalMinutes: resolved.authIntervalMinutes,
            log: (0, logger_1.createScopedLogger)(log, 'auth', resolved.debug),
        });
        this.client = new client_1.AlarmComClient({
            sessionManager,
            log: (0, logger_1.createScopedLogger)(log, 'api', resolved.debug),
        });
        api.on('didFinishLaunching', () => void this.#start(sessionManager));
        api.on('shutdown', () => this.#shutdown());
    }
    /** Homebridge replays cached accessories here on startup. */
    configureAccessory(accessory) {
        this.#cachedAccessories.set(accessory.UUID, accessory);
    }
    async #start(sessionManager) {
        try {
            await this.#discover();
        }
        catch (error) {
            this.#reportFailure('Initial discovery failed', error);
            return;
        }
        this.#startPolling();
        this.#startKeepAlive(sessionManager);
        if (this.#config.useEventStream) {
            this.#startEventStream();
        }
    }
    /** Enumerate the account's devices and publish them to HomeKit. */
    async #discover() {
        // Stamped before the work, not after. Recording only successful runs meant
        // a failing rediscovery was still due on the very next poll, so an account
        // that could not be enumerated was re-enumerated every interval instead of
        // hourly. That is the traffic pattern Alarm.com locks accounts for, and it
        // also displaced the ordinary refresh, so HomeKit went stale as well.
        this.#lastDiscoveryAt = Date.now();
        this.#systemId ??= await this.client.getSystemId();
        const devices = await this.client.getSystemDevices(this.#systemId);
        this.#log.info(`Discovered ${devices.partitionIds.length} partition(s) and ${devices.sensorIds.length} sensor(s)`);
        // Pruned as soon as the authoritative list is in hand, before the detail
        // reads that can still fail. Leaving it to the end meant a failure part
        // way through discarded what was already known, and a device deleted at
        // the panel went on being polled until a whole interval later.
        this.#reconcileKnownDevices(devices);
        const partitions = await this.client.getPartitions(devices.partitionIds.filter((id) => !this.#config.ignoredDeviceIds.has(id)));
        const sensors = await this.client.getSensors(devices.sensorIds.filter((id) => !this.#config.ignoredDeviceIds.has(id)));
        for (const partition of partitions) {
            this.#syncPartition(partition);
        }
        for (const sensor of sensors) {
            this.#syncSensor(sensor);
        }
        this.#removeStaleAccessories();
    }
    /** Find or create the accessory for a device, restoring from cache if present. */
    #resolveAccessory(deviceId, displayName, context) {
        const uuid = this.api.hap.uuid.generate(`${settings_1.UUID_PREFIX}${deviceId}`);
        const cached = this.#cachedAccessories.get(uuid);
        if (cached) {
            cached.context = { ...cached.context, ...context };
            this.api.updatePlatformAccessories([cached]);
            return { accessory: cached, isNew: false };
        }
        const accessory = new this.api.platformAccessory(displayName, uuid);
        accessory.context = context;
        this.#cachedAccessories.set(uuid, accessory);
        return { accessory, isNew: true };
    }
    /** Populate the standard AccessoryInformation service. */
    #applyAccessoryInformation(accessory, deviceId, model) {
        const service = accessory.getService(this.Service.AccessoryInformation)
            ?? accessory.addService(this.Service.AccessoryInformation);
        service
            .setCharacteristic(this.Characteristic.Manufacturer, settings_1.MANUFACTURER)
            .setCharacteristic(this.Characteristic.Model, model)
            .setCharacteristic(this.Characteristic.SerialNumber, deviceId);
    }
    #syncPartition(resource) {
        const deviceId = resource.id;
        const displayName = resource.attributes.description ?? `Partition ${resource.attributes.partitionId}`;
        const { accessory, isNew } = this.#resolveAccessory(deviceId, displayName, {
            deviceId,
            kind: 'partition',
            displayName,
        });
        this.#applyAccessoryInformation(accessory, deviceId, 'Security Panel');
        let handler = this.#partitions.get(deviceId);
        if (!handler) {
            handler = new partition_1.PartitionAccessory(this, accessory, (0, logger_1.createScopedLogger)(this.#log, 'partition', this.#config.debug));
            this.#partitions.set(deviceId, handler);
        }
        if (isNew) {
            this.#log.info(`Adding security system "${displayName}"`);
            this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
        }
        handler.update(resource);
    }
    #syncSensor(resource) {
        const deviceId = resource.id;
        const attributes = resource.attributes;
        const kind = (0, mappers_1.toSensorServiceKind)(attributes.deviceType);
        if (!kind) {
            this.#log.info(`Skipping "${attributes.description}": Alarm.com device type ${attributes.deviceType} is not supported yet.`);
            return;
        }
        if (attributes.isMonitoringEnabled === false && !this.#config.includeUnmonitoredSensors) {
            this.#log.info(`Skipping "${attributes.description}": Alarm.com reports monitoring is disabled. Set "includeUnmonitoredSensors" to expose it anyway.`);
            return;
        }
        const displayName = attributes.description;
        const { accessory, isNew } = this.#resolveAccessory(deviceId, displayName, {
            deviceId,
            kind,
            displayName,
        });
        this.#applyAccessoryInformation(accessory, deviceId, attributes.manufacturer ?? `${kind} sensor`);
        let handler = this.#sensors.get(deviceId);
        if (!handler) {
            handler = new sensor_1.SensorAccessory(this, accessory, kind, (0, logger_1.createScopedLogger)(this.#log, kind, this.#config.debug));
            this.#sensors.set(deviceId, handler);
        }
        if (isNew) {
            this.#log.info(`Adding ${kind} sensor "${displayName}"`);
            this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
        }
        handler.update(resource);
    }
    /**
     * Forget handlers for devices the account no longer reports.
     *
     * Without this the handler maps only ever grow, so a deleted device would
     * still be polled forever and would still look "live" to stale-accessory
     * removal, which is what kept it visible in HomeKit.
     */
    #reconcileKnownDevices(devices) {
        const reported = new Set([...devices.partitionIds, ...devices.sensorIds]);
        for (const map of [this.#partitions, this.#sensors]) {
            for (const deviceId of [...map.keys()]) {
                if (!reported.has(deviceId)) {
                    map.delete(deviceId);
                }
            }
        }
    }
    /** Unregister accessories for devices that no longer exist on the account. */
    #removeStaleAccessories() {
        const liveIds = new Set([...this.#partitions.keys(), ...this.#sensors.keys()]);
        for (const [uuid, accessory] of this.#cachedAccessories) {
            const deviceId = accessory.context.deviceId;
            if (deviceId && liveIds.has(deviceId)) {
                continue;
            }
            this.#log.info(`Removing "${accessory.displayName}", which is no longer on the account`);
            this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
            this.#cachedAccessories.delete(uuid);
        }
    }
    #startPolling() {
        const intervalMs = this.#config.pollIntervalSeconds * 1_000;
        this.#pollTimer = setInterval(() => {
            void this.#refreshAll();
        }, intervalMs);
        this.#log.info(`Polling Alarm.com every ${this.#config.pollIntervalSeconds}s`);
    }
    /**
     * Keep the session warm rather than letting it lapse into a fresh login.
     *
     * Signing in is the request Alarm.com polices hardest, so a periodic
     * keep-alive is the cheaper and safer way to stay authenticated.
     */
    #startKeepAlive(sessionManager) {
        this.#keepAliveTimer = setInterval(() => {
            void sessionManager.touch();
        }, settings_1.KEEPALIVE_INTERVAL_MS);
    }
    #startEventStream() {
        this.#eventStream = new event_stream_1.EventStream({
            log: (0, logger_1.createScopedLogger)(this.#log, 'events', this.#config.debug),
            requestToken: () => this.client.getEventStreamToken(),
            onDeviceEvent: (deviceId, event) => this.#handleDeviceEvent(deviceId, event),
            onUnavailable: () => {
                this.#log.warn('Continuing with polling only; HomeKit updates will be slower.');
            },
        });
        void this.#eventStream.start();
    }
    /**
     * Act on a pushed event.
     *
     * Where the event unambiguously implies a state, that state is published
     * immediately so a door opened and shut inside the refresh window still
     * registers in HomeKit. The re-read is always scheduled regardless and is
     * authoritative, so an immediate value that turns out to be wrong is
     * corrected within seconds instead of persisting.
     */
    #handleDeviceEvent(deviceId, event) {
        const sensor = this.#sensors.get(deviceId);
        const hint = (0, events_1.readSensorEventHint)(event, sensor?.kind);
        if (hint && sensor) {
            sensor.applyImmediateState(hint.isTriggered);
        }
        this.requestDeviceRefresh(deviceId);
    }
    /**
     * Schedule a targeted refresh of one device.
     *
     * Calls are coalesced over a short window because a single physical action
     * (a door opening) often produces several stream frames.
     */
    requestDeviceRefresh(deviceId) {
        this.#pendingRefreshIds.add(deviceId);
        if (this.#refreshTimer) {
            return;
        }
        this.#refreshTimer = setTimeout(() => {
            this.#refreshTimer = null;
            const ids = [...this.#pendingRefreshIds];
            this.#pendingRefreshIds.clear();
            void this.#refreshDevices(ids);
        }, REFRESH_DEBOUNCE_MS);
    }
    /** Re-read a specific set of devices and push their state to HomeKit. */
    async #refreshDevices(deviceIds) {
        const partitionIds = deviceIds.filter((id) => this.#partitions.has(id));
        const sensorIds = deviceIds.filter((id) => this.#sensors.has(id));
        try {
            for (const resource of await this.client.getPartitions(partitionIds)) {
                this.#partitions.get(resource.id)?.update(resource);
            }
            for (const resource of await this.client.getSensors(sensorIds)) {
                this.#sensors.get(resource.id)?.update(resource);
            }
        }
        catch (error) {
            this.#reportFailure('Targeted refresh failed', error);
        }
    }
    /**
     * Re-read every known device, occasionally re-enumerating the account.
     *
     * Refreshing only the devices already known cannot notice one being added or
     * deleted at the panel, so those changes would sit unreflected in HomeKit
     * until Homebridge restarted. Re-enumerating is a heavier call, so it runs on
     * its own slower cadence rather than on every poll.
     */
    async #refreshAll() {
        if (this.#isShuttingDown) {
            return;
        }
        const isRediscoveryDue = Date.now() - this.#lastDiscoveryAt >= settings_1.REDISCOVERY_INTERVAL_MS;
        try {
            if (isRediscoveryDue) {
                await this.#discover();
                return;
            }
            await this.#refreshDevices([...this.#partitions.keys(), ...this.#sensors.keys()]);
        }
        catch (error) {
            this.#reportFailure(isRediscoveryDue ? 'Rediscovery failed' : 'Poll failed', error);
        }
    }
    /**
     * Log a failure at a level matching whether the user can act on it.
     *
     * Transient trouble is logged quietly; a bad password or a stale two-factor
     * cookie is logged loudly, because nothing will improve until it is fixed.
     */
    #reportFailure(context, error) {
        const message = `${context}: ${(0, sanitizers_1.sanitizeError)(error)}`;
        if (error instanceof errors_1.AlarmComError && error.isRetryable) {
            this.#log.debug(message);
            return;
        }
        this.#log.error(message);
    }
    #shutdown() {
        this.#isShuttingDown = true;
        for (const timer of [this.#pollTimer, this.#keepAliveTimer, this.#refreshTimer]) {
            if (timer) {
                clearTimeout(timer);
                clearInterval(timer);
            }
        }
        this.#pollTimer = null;
        this.#keepAliveTimer = null;
        this.#refreshTimer = null;
        this.#eventStream?.stop();
        this.#eventStream = null;
    }
}
exports.MyAlarmComPlatform = MyAlarmComPlatform;
//# sourceMappingURL=platform.js.map