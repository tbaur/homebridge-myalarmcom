/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Homebridge dynamic platform: discovery, state, and lifecycle.
 */

import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  Service,
} from 'homebridge'
import { AlarmComClient, type SystemDevices } from './api/client'
import { EventStream } from './api/event-stream'
import { SessionManager } from './api/session-manager'
import {
  DiagnosticsCollector,
  type DeviceGauges,
  type DiagnosticsReaders,
} from './diagnostics/collector'
import type { DiagnosticsSnapshot } from './diagnostics/types'
import { PartitionAccessory } from './devices/partition'
import { SensorAccessory } from './devices/sensor'
import {
  KEEPALIVE_INTERVAL_MS,
  MANUFACTURER,
  PLATFORM_NAME,
  PLUGIN_NAME,
  REDISCOVERY_INTERVAL_MS,
  UUID_PREFIX,
} from './settings'
import type { PartitionAttributes, Resource, SensorAttributes } from './types/alarm'
import { readSensorEventHint, type AlarmComEvent } from './types/events'
import type { MyAlarmComPlatformConfig, ResolvedConfig } from './types/config'
import { initialDiscoveryRetryDelayMs } from './utils/discovery-retry'
import { failureLogLevel } from './utils/failure-log-level'
import { createScopedLogger, type Logger } from './utils/logger'
import { toSensorServiceKind } from './utils/mappers'
import { sleep } from './utils/retry'
import { sanitizeError } from './utils/sanitizers'
import { validateConfig } from './utils/validators'

/**
 * Installed plugin version, used for diagnostics lifecycle reporting.
 *
 * Resolved once via `require` rather than a static `import`: `package.json`
 * lives outside the TypeScript `rootDir` (`src/`), so importing it would alter
 * the emitted `dist/` layout. The require resolves correctly from both the
 * compiled `dist/` output and ts-jest.
 */
function readPluginVersion(): string {
  try {
    return (require('../package.json') as { version: string }).version || 'unknown'
  } catch {
    return 'unknown'
  }
}

const PLUGIN_VERSION = readPluginVersion()

/** Window over which event-triggered refreshes are coalesced. */
const REFRESH_DEBOUNCE_MS = 750

/** Homebridge platform exposing Alarm.com partitions and sensors. */
export class MyAlarmComPlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service
  readonly Characteristic: typeof Characteristic
  readonly api: API
  readonly client: AlarmComClient

  readonly #log: Logger
  readonly #config: ResolvedConfig
  readonly #cachedAccessories = new Map<string, PlatformAccessory>()
  readonly #partitions = new Map<string, PartitionAccessory>()
  readonly #sensors = new Map<string, SensorAccessory>()

  #eventStream: EventStream | null = null
  #pollTimer: NodeJS.Timeout | null = null
  #keepAliveTimer: NodeJS.Timeout | null = null
  #refreshTimer: NodeJS.Timeout | null = null
  #diagnosticsTimer: NodeJS.Timeout | null = null
  /** Interrupts a pending initial-discovery backoff when Homebridge shuts down. */
  #startupRetryResolve: (() => void) | null = null
  #pendingRefreshIds = new Set<string>()
  #systemId: string | null = null
  #isShuttingDown = false
  /** Prevents stacked poll cycles when a refresh outlasts the poll interval. */
  #refreshAllInFlight = false
  /** When the account was last re-enumerated, driving periodic rediscovery. */
  #lastDiscoveryAt = 0
  readonly #diagnostics: DiagnosticsCollector
  #lastDiagnosticsHealth: 'healthy' | 'degraded' | null = null

  constructor(log: Logging, config: MyAlarmComPlatformConfig, api: API) {
    this.api = api
    this.Service = api.hap.Service
    this.Characteristic = api.hap.Characteristic

    const { config: resolved, warnings } = validateConfig(config)
    this.#config = resolved
    this.#log = createScopedLogger(log, 'platform', resolved.debug)

    // Routed through the scoped logger rather than the raw Homebridge one so
    // the "every line is redacted" guarantee holds without exception. Config
    // warnings quote user-supplied values, which is precisely where a
    // mistakenly pasted secret would surface.
    for (const warning of warnings) {
      this.#log.warn(warning)
    }

    // Counters always accumulate; heartbeats are only emitted when
    // diagnosticsInterval > 0.
    this.#diagnostics = new DiagnosticsCollector({
      pluginVersion: PLUGIN_VERSION,
      config: resolved,
    })

    const sessionManager = new SessionManager({
      credentials: {
        username: resolved.username,
        password: resolved.password,
        twoFactorAuthenticationId: resolved.twoFactorAuthenticationId,
      },
      authIntervalMinutes: resolved.authIntervalMinutes,
      log: createScopedLogger(log, 'auth', resolved.debug),
      onSessionEstablished: () => this.#diagnostics.sessionLogin(),
    })

    this.client = new AlarmComClient({
      sessionManager,
      log: createScopedLogger(log, 'api', resolved.debug),
      metrics: (sample) => this.#diagnostics.apiRequest(sample.durationMs, sample.ok, sample.networked),
      onCircuitOpen: () => this.#diagnostics.breakerTrip(),
      onThrottle: () => this.#diagnostics.throttle(),
      onRetry: () => this.#diagnostics.retry(),
    })

    api.on('didFinishLaunching', () => void this.#start(sessionManager))
    api.on('shutdown', () => this.#shutdown())
  }

  /** Homebridge replays cached accessories here on startup. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.#cachedAccessories.set(accessory.UUID, accessory)
  }

  async #start(sessionManager: SessionManager): Promise<void> {
    if (!(await this.#awaitInitialDiscovery())) {
      return
    }

    if (this.#isShuttingDown) {
      return
    }

    this.#startPolling()
    this.#startKeepAlive(sessionManager)

    if (this.#config.useEventStream) {
      // Await the first handshake so "connected" (or the failure warning) lands
      // before Ready. Later reconnects are runtime events and may log after.
      await this.#startEventStream()
    }

    if (this.#isShuttingDown) {
      // Shutdown won the race with a slow stream handshake; tear down anything
      // startEventStream may have installed after #shutdown ran.
      this.#eventStream?.stop()
      this.#eventStream = null
      return
    }

    this.#startDiagnostics()
    this.#log.info('Ready')
  }

  /**
   * Discover devices, retrying transient failures until success or shutdown.
   *
   * Without this, a network blip at boot left the platform idle with no Ready,
   * no polling, and — for retryable errors — only a debug log.
   */
  async #awaitInitialDiscovery(): Promise<boolean> {
    let attempt = 0

    for (;;) {
      if (this.#isShuttingDown) {
        return false
      }

      try {
        await this.#discover()
        return true
      } catch (error) {
        const detail = sanitizeError(error)
        const delayMs = initialDiscoveryRetryDelayMs(error, attempt + 1)

        if (delayMs === null) {
          this.#log.error(`Initial discovery failed: ${detail}`)
          return false
        }

        attempt++
        this.#log.warn(
          `Initial discovery failed: ${detail}. Retrying in ${Math.round(delayMs / 1000)}s.`,
        )

        if (!(await this.#sleepUnlessShuttingDown(delayMs))) {
          return false
        }
      }
    }
  }

  /** Backoff wait that resolves early (as false) when {@link #shutdown} runs. */
  #sleepUnlessShuttingDown(ms: number): Promise<boolean> {
    if (this.#isShuttingDown) {
      return Promise.resolve(false)
    }

    return new Promise((resolve) => {
      let settled = false
      const finish = (continued: boolean): void => {
        if (settled) {
          return
        }
        settled = true
        this.#startupRetryResolve = null
        resolve(continued)
      }

      this.#startupRetryResolve = () => finish(false)
      // Uses the shared sleep helper so tests can skip real wall-clock waits.
      void sleep(ms).then(() => finish(!this.#isShuttingDown))
    })
  }

  /** Enumerate the account's devices and publish them to HomeKit. */
  async #discover(): Promise<void> {
    // Stamped before the work, not after. Recording only successful runs meant
    // a failing rediscovery was still due on the very next poll, so an account
    // that could not be enumerated was re-enumerated every interval instead of
    // hourly. That is the traffic pattern Alarm.com locks accounts for, and it
    // also displaced the ordinary refresh, so HomeKit went stale as well.
    this.#lastDiscoveryAt = Date.now()

    this.#systemId ??= await this.client.getSystemId()
    const devices = await this.client.getSystemDevices(this.#systemId)

    this.#log.info(
      `Discovered ${devices.partitionIds.length} partition(s) and ${devices.sensorIds.length} sensor(s)`,
    )

    // Pruned as soon as the authoritative list is in hand, before the detail
    // reads that can still fail. Leaving it to the end meant a failure part
    // way through discarded what was already known, and a device deleted at
    // the panel went on being polled until a whole interval later.
    this.#reconcileKnownDevices(devices)

    // Unregister HomeKit accessories for devices deleted at the panel (and for
    // explicitly ignored IDs) immediately, so a later detail-read failure
    // cannot leave ghosts until the next hourly rediscovery.
    const liveForHomeKit = new Set(
      [...devices.partitionIds, ...devices.sensorIds]
        .filter((id) => !this.#config.ignoredDeviceIds.has(id)),
    )
    this.#removeStaleAccessories(liveForHomeKit)

    const partitions = await this.client.getPartitions(
      devices.partitionIds.filter((id) => !this.#config.ignoredDeviceIds.has(id)),
    )
    const sensors = await this.client.getSensors(
      devices.sensorIds.filter((id) => !this.#config.ignoredDeviceIds.has(id)),
    )

    for (const partition of partitions) {
      this.#syncPartition(partition)
    }
    for (const sensor of sensors) {
      this.#syncSensor(sensor)
    }

    // After sync, prune accessories that are still on the account but were not
    // published (unsupported types, unmonitored sensors when disabled).
    this.#removeStaleAccessories()
  }

  /** Find or create the accessory for a device, restoring from cache if present. */
  #resolveAccessory(
    deviceId: string,
    displayName: string,
    context: Record<string, unknown>,
  ): { accessory: PlatformAccessory, isNew: boolean } {
    const uuid = this.api.hap.uuid.generate(`${UUID_PREFIX}${deviceId}`)
    const cached = this.#cachedAccessories.get(uuid)

    if (cached) {
      cached.context = { ...cached.context, ...context }
      this.api.updatePlatformAccessories([cached])
      return { accessory: cached, isNew: false }
    }

    const accessory = new this.api.platformAccessory(displayName, uuid)
    accessory.context = context
    this.#cachedAccessories.set(uuid, accessory)
    return { accessory, isNew: true }
  }

  /** Populate the standard AccessoryInformation service. */
  #applyAccessoryInformation(accessory: PlatformAccessory, deviceId: string, model: string): void {
    const service = accessory.getService(this.Service.AccessoryInformation)
      ?? accessory.addService(this.Service.AccessoryInformation)

    service
      .setCharacteristic(this.Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(this.Characteristic.Model, model)
      .setCharacteristic(this.Characteristic.SerialNumber, deviceId)
  }

  #syncPartition(resource: Resource<PartitionAttributes>): void {
    const deviceId = resource.id
    const displayName = resource.attributes.description ?? `Partition ${resource.attributes.partitionId}`

    const { accessory, isNew } = this.#resolveAccessory(deviceId, displayName, {
      deviceId,
      kind: 'partition',
      displayName,
    })

    this.#applyAccessoryInformation(accessory, deviceId, 'Security Panel')

    let handler = this.#partitions.get(deviceId)
    if (!handler) {
      handler = new PartitionAccessory(
        this,
        accessory,
        createScopedLogger(this.#log, 'partition', this.#config.debug),
      )
      this.#partitions.set(deviceId, handler)
    }

    if (isNew) {
      this.#log.info(`Adding security system "${displayName}"`)
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
    }

    handler.update(resource)
  }

  #syncSensor(resource: Resource<SensorAttributes>): void {
    const deviceId = resource.id
    const attributes = resource.attributes
    const kind = toSensorServiceKind(attributes.deviceType)

    if (!kind) {
      this.#log.info(
        `Skipping "${attributes.description}": Alarm.com device type ${attributes.deviceType} is not supported yet.`,
      )
      // Drop a previously published handler so post-sync stale removal can
      // unregister the HomeKit accessory on a live rediscovery.
      this.#sensors.delete(deviceId)
      return
    }

    if (attributes.isMonitoringEnabled === false && !this.#config.includeUnmonitoredSensors) {
      this.#log.info(
        `Skipping "${attributes.description}": Alarm.com reports monitoring is disabled. Set "includeUnmonitoredSensors" to expose it anyway.`,
      )
      this.#sensors.delete(deviceId)
      return
    }

    const displayName = attributes.description
    const { accessory, isNew } = this.#resolveAccessory(deviceId, displayName, {
      deviceId,
      kind,
      displayName,
    })

    this.#applyAccessoryInformation(accessory, deviceId, attributes.manufacturer ?? `${kind} sensor`)

    let handler = this.#sensors.get(deviceId)
    if (!handler) {
      handler = new SensorAccessory(
        this,
        accessory,
        kind,
        createScopedLogger(this.#log, kind, this.#config.debug),
      )
      this.#sensors.set(deviceId, handler)
    }

    if (isNew) {
      this.#log.info(`Adding ${kind} sensor "${displayName}"`)
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
    }

    handler.update(resource)
  }

  /**
   * Forget handlers for devices the account no longer reports.
   *
   * Without this the handler maps only ever grow, so a deleted device would
   * still be polled forever and would still look "live" to stale-accessory
   * removal, which is what kept it visible in HomeKit.
   */
  #reconcileKnownDevices(devices: SystemDevices): void {
    const reported = new Set<string>([...devices.partitionIds, ...devices.sensorIds])

    for (const map of [this.#partitions, this.#sensors] as ReadonlyArray<Map<string, unknown>>) {
      for (const deviceId of [...map.keys()]) {
        if (!reported.has(deviceId)) {
          map.delete(deviceId)
        }
      }
    }
  }

  /** Unregister accessories for devices that no longer exist on the account. */
  #removeStaleAccessories(liveIds?: ReadonlySet<string>): void {
    const live = liveIds ?? new Set([...this.#partitions.keys(), ...this.#sensors.keys()])

    for (const [uuid, accessory] of this.#cachedAccessories) {
      const deviceId = (accessory.context as { deviceId?: string }).deviceId

      if (deviceId && live.has(deviceId)) {
        continue
      }

      this.#log.info(`Removing "${accessory.displayName}", which is no longer on the account`)
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
      this.#cachedAccessories.delete(uuid)
    }
  }

  #startPolling(): void {
    if (this.#isShuttingDown || this.#pollTimer) {
      return
    }
    const intervalMs = this.#config.pollIntervalSeconds * 1_000
    this.#pollTimer = setInterval(() => {
      void this.#refreshAll()
    }, intervalMs)
    this.#log.debug(`Polling Alarm.com every ${this.#config.pollIntervalSeconds}s`)
  }

  /**
   * Keep the session warm rather than letting it lapse into a fresh login.
   *
   * Signing in is the request Alarm.com polices hardest, so a periodic
   * keep-alive is the cheaper and safer way to stay authenticated.
   */
  #startKeepAlive(sessionManager: SessionManager): void {
    if (this.#isShuttingDown || this.#keepAliveTimer) {
      return
    }
    this.#keepAliveTimer = setInterval(() => {
      void sessionManager.touch().then((isAlive) => {
        if (!isAlive) {
          this.#log.debug('Session keep-alive did not confirm a live session')
        }
      })
    }, KEEPALIVE_INTERVAL_MS)
  }

  async #startEventStream(): Promise<void> {
    if (this.#isShuttingDown) {
      return
    }
    this.#eventStream = new EventStream({
      log: createScopedLogger(this.#log, 'events', this.#config.debug),
      requestToken: () => this.client.getEventStreamToken(),
      onDeviceEvent: (deviceId, event) => this.#handleDeviceEvent(deviceId, event),
      onUnavailable: () => {
        this.#log.warn('Continuing with polling only; HomeKit updates will be slower.')
      },
      onReconnect: () => this.#diagnostics.wsReconnect(),
      onRecovered: () => this.#log.debug('Event stream recovery recorded'),
    })

    await this.#eventStream.start()
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
  #handleDeviceEvent(deviceId: string, event: AlarmComEvent): void {
    const sensor = this.#sensors.get(deviceId)
    const hint = readSensorEventHint(event, sensor?.kind)

    if (hint && sensor) {
      sensor.applyImmediateState(hint.isTriggered)
    }

    this.#diagnostics.externalChange()
    this.requestDeviceRefresh(deviceId)
  }

  /** Record a HomeKit-originated arming command for diagnostics. */
  recordCommand(): void {
    this.#diagnostics.command()
  }

  /**
   * Schedule a targeted refresh of one device.
   *
   * Calls are coalesced over a short window because a single physical action
   * (a door opening) often produces several stream frames.
   */
  requestDeviceRefresh(deviceId: string): void {
    this.#pendingRefreshIds.add(deviceId)

    if (this.#refreshTimer) {
      return
    }

    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null
      const ids = [...this.#pendingRefreshIds]
      this.#pendingRefreshIds.clear()
      void this.#refreshDevices(ids).catch((error: unknown) => {
        this.#reportFailure('Targeted refresh failed', error)
      })
    }, REFRESH_DEBOUNCE_MS)
  }

  /** Re-read a specific set of devices and push their state to HomeKit. */
  async #refreshDevices(deviceIds: string[]): Promise<void> {
    const partitionIds = deviceIds.filter((id) => this.#partitions.has(id))
    const sensorIds = deviceIds.filter((id) => this.#sensors.has(id))

    for (const resource of await this.client.getPartitions(partitionIds)) {
      this.#partitions.get(resource.id)?.update(resource)
    }
    for (const resource of await this.client.getSensors(sensorIds)) {
      this.#sensors.get(resource.id)?.update(resource)
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
  async #refreshAll(): Promise<void> {
    if (this.#isShuttingDown || this.#refreshAllInFlight) {
      return
    }

    this.#refreshAllInFlight = true
    const isRediscoveryDue = Date.now() - this.#lastDiscoveryAt >= REDISCOVERY_INTERVAL_MS
    const started = Date.now()
    let ok = 0
    let failed = 0

    try {
      if (isRediscoveryDue) {
        await this.#discover()
        ok = this.#partitions.size + this.#sensors.size
        return
      }

      const deviceIds = [...this.#partitions.keys(), ...this.#sensors.keys()]
      await this.#refreshDevices(deviceIds)
      ok = deviceIds.length
    } catch (error) {
      failed = 1
      this.#reportFailure(isRediscoveryDue ? 'Rediscovery failed' : 'Poll failed', error)
    } finally {
      this.#refreshAllInFlight = false
      this.#diagnostics.pollCycle(ok, failed, Date.now() - started)
    }
  }

  /**
   * Log a failure at a level matching whether the user can act on it.
   *
   * Transient trouble is logged quietly; a bad password or a stale two-factor
   * cookie is logged loudly, because nothing will improve until it is fixed.
   */
  #reportFailure(context: string, error: unknown): void {
    const message = `${context}: ${sanitizeError(error)}`
    const level = failureLogLevel(error)
    this.#log[level](message)
  }

  #diagnosticsIntervalMs(): number {
    const seconds = this.#config.diagnosticsInterval
    return seconds > 0 ? seconds * 1_000 : 0
  }

  /**
   * Starts the diagnostics subsystem: emits the boot snapshot and schedules the
   * heartbeat. No-op unless diagnosticsInterval > 0.
   */
  #startDiagnostics(): void {
    const interval = this.#diagnosticsIntervalMs()
    if (interval <= 0 || this.#isShuttingDown || this.#diagnosticsTimer) {
      return
    }

    // Diagnostics must never be able to crash the host.
    try {
      const startReport = this.#diagnostics.snapshot('diagnostics.start', this.#buildDiagnosticsReaders())
      this.#lastDiagnosticsHealth = startReport.lifecycle.health
      this.#emitDiagnostic('info', startReport)
    } catch (error) {
      this.#log.debug(`Failed to emit diagnostics start snapshot: ${sanitizeError(error)}`)
    }

    this.#diagnosticsTimer = setInterval(() => this.#diagnosticsHeartbeat(), interval)
  }

  #diagnosticsHeartbeat(): void {
    try {
      const report = this.#diagnostics.buildHeartbeat(this.#buildDiagnosticsReaders())
      this.#emitDiagnostic('info', report)

      const health = report.lifecycle.health
      if (this.#lastDiagnosticsHealth !== null && health !== this.#lastDiagnosticsHealth) {
        const isDegraded = health === 'degraded'
        const transition: DiagnosticsSnapshot = {
          ...report,
          msg: isDegraded ? 'health.degraded' : 'health.recovered',
        }
        this.#emitDiagnostic(isDegraded ? 'warn' : 'info', transition)
      }
      this.#lastDiagnosticsHealth = health
    } catch (error) {
      this.#log.debug(`Diagnostics heartbeat failed: ${sanitizeError(error)}`)
    }
  }

  #buildDiagnosticsReaders(): DiagnosticsReaders {
    return {
      clientStatus: () => this.client.getStatus(),
      wsStatus: () => this.#eventStream?.getStatus() ?? null,
      devices: () => this.#collectDeviceGauges(),
      pollingCadenceSec: () => this.#config.pollIntervalSeconds,
      eventStreamExpected: () => this.#config.useEventStream,
    }
  }

  #collectDeviceGauges(): DeviceGauges {
    const byType: Record<string, number> = {}

    for (const sensor of this.#sensors.values()) {
      byType[sensor.kind] = (byType[sensor.kind] ?? 0) + 1
    }

    return {
      partitions: this.#partitions.size,
      sensors: this.#sensors.size,
      byType,
      ignored: this.#config.ignoredDeviceIds.size,
    }
  }

  /**
   * Emit a diagnostics report as a human-readable line only.
   *
   * Homebridge's logger stringifies any extra arguments onto the same line, so
   * passing the structured snapshot as a second arg produced the giant JSON
   * blob users saw after every Health / Diagnostics start line. Keep the full
   * payload on a separate debug entry when debug logging is enabled.
   */
  #emitDiagnostic(level: 'info' | 'warn', report: DiagnosticsSnapshot): void {
    this.#log[level](formatDiagnosticLine(report))

    const { lifecycle, msg, ...groups } = report
    this.#log.debug('Diagnostics snapshot', {
      msg,
      ...groups,
      ...lifecycle,
    })
  }

  #shutdown(): void {
    this.#isShuttingDown = true

    const resolveStartupRetry = this.#startupRetryResolve
    this.#startupRetryResolve = null
    resolveStartupRetry?.()

    if (this.#diagnosticsTimer) {
      try {
        this.#emitDiagnostic(
          'info',
          this.#diagnostics.snapshot('diagnostics.stop', this.#buildDiagnosticsReaders()),
        )
      } catch (error) {
        this.#log.debug(`Failed to emit diagnostics stop snapshot: ${sanitizeError(error)}`)
      }
      clearInterval(this.#diagnosticsTimer)
      this.#diagnosticsTimer = null
    }

    for (const timer of [this.#pollTimer, this.#keepAliveTimer, this.#refreshTimer]) {
      if (timer) {
        clearTimeout(timer)
        clearInterval(timer)
      }
    }

    this.#pollTimer = null
    this.#keepAliveTimer = null
    this.#refreshTimer = null
    this.#eventStream?.stop()
    this.#eventStream = null
  }
}

/** Human-readable label for a diagnostics channel. */
function diagnosticLabel(msg: string): string {
  switch (msg) {
    case 'health':
      return 'Health'
    case 'diagnostics.start':
      return 'Diagnostics start'
    case 'diagnostics.stop':
      return 'Diagnostics stop'
    case 'health.degraded':
      return 'Health degraded'
    case 'health.recovered':
      return 'Health recovered'
    default:
      return msg
  }
}

/** Concise human-readable summary line for a diagnostics report. */
function formatDiagnosticLine(report: DiagnosticsSnapshot): string {
  const { lifecycle, devices, websocket, api } = report
  const reasonText = lifecycle.reasons.length > 0 ? ` [${lifecycle.reasons.join(', ')}]` : ''

  return (
    `${diagnosticLabel(report.msg)}: ${lifecycle.health}${reasonText} | `
    + `devices ${devices.partitions}p/${devices.sensors}s | `
    + `ws ${websocket.state} | `
    + `api p50 ${api.p50Ms}ms p95 ${api.p95Ms}ms (req ${api.requests}, err ${api.errors})`
  )
}
