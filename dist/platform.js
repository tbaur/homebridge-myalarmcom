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
const collector_1 = require("./diagnostics/collector");
const partition_1 = require("./devices/partition");
const sensor_1 = require("./devices/sensor");
const errors_1 = require("./errors");
const settings_1 = require("./settings");
const events_1 = require("./types/events");
const logger_1 = require("./utils/logger");
const mappers_1 = require("./utils/mappers");
const sanitizers_1 = require("./utils/sanitizers");
const validators_1 = require("./utils/validators");
/**
 * Installed plugin version, used for diagnostics lifecycle reporting.
 *
 * Resolved once via `require` rather than a static `import`: `package.json`
 * lives outside the TypeScript `rootDir` (`src/`), so importing it would alter
 * the emitted `dist/` layout. The require resolves correctly from both the
 * compiled `dist/` output and ts-jest.
 */
function readPluginVersion() {
    try {
        return require('../package.json').version || 'unknown';
    }
    catch {
        return 'unknown';
    }
}
const PLUGIN_VERSION = readPluginVersion();
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
    #diagnosticsTimer = null;
    #pendingRefreshIds = new Set();
    #systemId = null;
    #isShuttingDown = false;
    /** When the account was last re-enumerated, driving periodic rediscovery. */
    #lastDiscoveryAt = 0;
    #diagnostics;
    #lastDiagnosticsHealth = null;
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
        // Counters always accumulate; heartbeats are only emitted when
        // diagnosticsInterval > 0.
        this.#diagnostics = new collector_1.DiagnosticsCollector({
            pluginVersion: PLUGIN_VERSION,
            config: resolved,
        });
        const sessionManager = new session_manager_1.SessionManager({
            credentials: {
                username: resolved.username,
                password: resolved.password,
                twoFactorAuthenticationId: resolved.twoFactorAuthenticationId,
            },
            authIntervalMinutes: resolved.authIntervalMinutes,
            log: (0, logger_1.createScopedLogger)(log, 'auth', resolved.debug),
            onSessionEstablished: () => this.#diagnostics.sessionLogin(),
        });
        this.client = new client_1.AlarmComClient({
            sessionManager,
            log: (0, logger_1.createScopedLogger)(log, 'api', resolved.debug),
            metrics: (sample) => this.#diagnostics.apiRequest(sample.durationMs, sample.ok, sample.networked),
            onCircuitOpen: () => this.#diagnostics.breakerTrip(),
            onThrottle: () => this.#diagnostics.throttle(),
            onRetry: () => this.#diagnostics.retry(),
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
        this.#startDiagnostics();
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
            onReconnect: () => this.#diagnostics.wsReconnect(),
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
        this.#diagnostics.externalChange();
        this.requestDeviceRefresh(deviceId);
    }
    /** Record a HomeKit-originated arming command for diagnostics. */
    recordCommand() {
        this.#diagnostics.command();
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
        const started = Date.now();
        let ok = 0;
        let failed = 0;
        try {
            if (isRediscoveryDue) {
                await this.#discover();
                ok = this.#partitions.size + this.#sensors.size;
                return;
            }
            const deviceIds = [...this.#partitions.keys(), ...this.#sensors.keys()];
            await this.#refreshDevices(deviceIds);
            ok = deviceIds.length;
        }
        catch (error) {
            failed = 1;
            this.#reportFailure(isRediscoveryDue ? 'Rediscovery failed' : 'Poll failed', error);
        }
        finally {
            this.#diagnostics.pollCycle(ok, failed, Date.now() - started);
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
    #diagnosticsIntervalMs() {
        const seconds = this.#config.diagnosticsInterval;
        return seconds > 0 ? seconds * 1_000 : 0;
    }
    /**
     * Starts the diagnostics subsystem: emits the boot snapshot and schedules the
     * heartbeat. No-op unless diagnosticsInterval > 0.
     */
    #startDiagnostics() {
        const interval = this.#diagnosticsIntervalMs();
        if (interval <= 0 || this.#isShuttingDown || this.#diagnosticsTimer) {
            return;
        }
        // Diagnostics must never be able to crash the host.
        try {
            const startReport = this.#diagnostics.snapshot('diagnostics.start', this.#buildDiagnosticsReaders());
            this.#lastDiagnosticsHealth = startReport.lifecycle.health;
            this.#emitDiagnostic('info', startReport);
        }
        catch (error) {
            this.#log.debug(`Failed to emit diagnostics start snapshot: ${(0, sanitizers_1.sanitizeError)(error)}`);
        }
        this.#diagnosticsTimer = setInterval(() => this.#diagnosticsHeartbeat(), interval);
    }
    #diagnosticsHeartbeat() {
        try {
            const report = this.#diagnostics.buildHeartbeat(this.#buildDiagnosticsReaders());
            this.#emitDiagnostic('info', report);
            const health = report.lifecycle.health;
            if (this.#lastDiagnosticsHealth !== null && health !== this.#lastDiagnosticsHealth) {
                const isDegraded = health === 'degraded';
                const transition = {
                    ...report,
                    msg: isDegraded ? 'health.degraded' : 'health.recovered',
                };
                this.#emitDiagnostic(isDegraded ? 'warn' : 'info', transition);
            }
            this.#lastDiagnosticsHealth = health;
        }
        catch (error) {
            this.#log.debug(`Diagnostics heartbeat failed: ${(0, sanitizers_1.sanitizeError)(error)}`);
        }
    }
    #buildDiagnosticsReaders() {
        return {
            clientStatus: () => this.client.getStatus(),
            wsStatus: () => this.#eventStream?.getStatus() ?? null,
            devices: () => this.#collectDeviceGauges(),
            pollingCadenceSec: () => this.#config.pollIntervalSeconds,
            eventStreamExpected: () => this.#config.useEventStream,
        };
    }
    #collectDeviceGauges() {
        const byType = {};
        for (const sensor of this.#sensors.values()) {
            byType[sensor.kind] = (byType[sensor.kind] ?? 0) + 1;
        }
        return {
            partitions: this.#partitions.size,
            sensors: this.#sensors.size,
            byType,
            ignored: this.#config.ignoredDeviceIds.size,
        };
    }
    /**
     * Emit a diagnostics report as a human-readable line only.
     *
     * Homebridge's logger stringifies any extra arguments onto the same line, so
     * passing the structured snapshot as a second arg produced the giant JSON
     * blob users saw after every Health / Diagnostics start line. Keep the full
     * payload on a separate debug entry when debug logging is enabled.
     */
    #emitDiagnostic(level, report) {
        this.#log[level](formatDiagnosticLine(report));
        const { lifecycle, msg, ...groups } = report;
        this.#log.debug('Diagnostics snapshot', {
            msg,
            ...groups,
            ...lifecycle,
        });
    }
    #shutdown() {
        this.#isShuttingDown = true;
        if (this.#diagnosticsTimer) {
            try {
                this.#emitDiagnostic('info', this.#diagnostics.snapshot('diagnostics.stop', this.#buildDiagnosticsReaders()));
            }
            catch (error) {
                this.#log.debug(`Failed to emit diagnostics stop snapshot: ${(0, sanitizers_1.sanitizeError)(error)}`);
            }
            clearInterval(this.#diagnosticsTimer);
            this.#diagnosticsTimer = null;
        }
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
/** Human-readable label for a diagnostics channel. */
function diagnosticLabel(msg) {
    switch (msg) {
        case 'health':
            return 'Health';
        case 'diagnostics.start':
            return 'Diagnostics start';
        case 'diagnostics.stop':
            return 'Diagnostics stop';
        case 'health.degraded':
            return 'Health degraded';
        case 'health.recovered':
            return 'Health recovered';
        default:
            return msg;
    }
}
/** Concise human-readable summary line for a diagnostics report. */
function formatDiagnosticLine(report) {
    const { lifecycle, devices, websocket, api } = report;
    const reasonText = lifecycle.reasons.length > 0 ? ` [${lifecycle.reasons.join(', ')}]` : '';
    const typeBits = Object.entries(devices.byType)
        .map(([kind, count]) => `${count} ${kind}`)
        .join(', ');
    const deviceSummary = typeBits.length > 0
        ? `${devices.partitions}p/${devices.sensors}s (${typeBits})`
        : `${devices.partitions}p/${devices.sensors}s`;
    return (`${diagnosticLabel(report.msg)}: ${lifecycle.health}${reasonText} | `
        + `devices ${deviceSummary} | `
        + `ws ${websocket.state} | `
        + `api p50 ${api.p50Ms}ms p95 ${api.p95Ms}ms (req ${api.requests}, err ${api.errors})`);
}
//# sourceMappingURL=platform.js.map