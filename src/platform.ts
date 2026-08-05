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
import { DiagnosticsReporter } from './diagnostics/reporter'
import { PartitionAccessory, type PartitionAccessoryContext } from './devices/partition'
import { SensorAccessory, type SensorAccessoryContext } from './devices/sensor'
import { ConfigurationError } from './errors'
import {
  KEEPALIVE_INTERVAL_MS,
  MANUFACTURER,
  MS_PER_SECOND,
  PLATFORM_NAME,
  PLUGIN_NAME,
  POLL_CYCLE_DEADLINE_MS,
  POLL_FAILURE_WARN_THRESHOLD,
  REDISCOVERY_INTERVAL_MS,
  REFRESH_DEBOUNCE_MS,
  UUID_PREFIX,
} from './settings'
import type {
  PartitionAttributes,
  Resource,
  SensorAttributes,
  SensorServiceKind,
} from './types/alarm'
import { readSensorEventHint, type AlarmComEvent } from './types/events'
import type { MyAlarmComPlatformConfig, ResolvedConfig } from './types/config'
import { initialDiscoveryRetryDelayMs } from './utils/discovery-retry'
import { failureLogLevel } from './utils/failure-log-level'
import { createScopedLogger, type Logger } from './utils/logger'
import { toSensorServiceKind } from './utils/mappers'
import { sleep } from './utils/retry'
import { sanitizeError } from './utils/sanitizers'
import { validateConfig } from './utils/validators'
import { PLUGIN_VERSION } from './utils/version'

/** What the platform stores on any accessory it publishes. */
type AccessoryContext = PartitionAccessoryContext | SensorAccessoryContext

/**
 * Stand-in used when the configuration is unusable.
 *
 * The platform still constructs its logger and diagnostics so it can explain
 * itself, but it publishes nothing and starts no timers, so none of these
 * values is ever acted on. Credentials are empty rather than absent because
 * there is no sign-in to attempt.
 */
const DISABLED_CONFIG: ResolvedConfig = {
  username: '',
  password: '',
  twoFactorAuthenticationId: '',
  pollIntervalSeconds: 0,
  authIntervalMinutes: 0,
  useEventStream: false,
  ignoredDeviceIds: new Set(),
  includeUnmonitoredSensors: false,
  debug: false,
  diagnosticsInterval: 0,
}

/** Homebridge platform exposing Alarm.com partitions and sensors. */
export class MyAlarmComPlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service
  readonly Characteristic: typeof Characteristic
  readonly api: API

  readonly #rawLog: Logging
  readonly #log: Logger
  readonly #config: ResolvedConfig
  readonly #diagnostics: DiagnosticsCollector
  readonly #reporter: DiagnosticsReporter
  readonly #partitionLog: Logger
  /** Both `null` when the configuration is unusable, so nothing can sign in. */
  readonly #client: AlarmComClient | null
  readonly #sessionManager: SessionManager | null
  readonly #cachedAccessories = new Map<string, PlatformAccessory>()
  readonly #partitions = new Map<string, PartitionAccessory>()
  readonly #sensors = new Map<string, SensorAccessory>()
  /** One logger per sensor kind, reused rather than rebuilt per device. */
  readonly #sensorLogs = new Map<SensorServiceKind, Logger>()
  /** Devices already reported as skipped, so an hourly rediscovery stays quiet. */
  readonly #reportedSkips = new Set<string>()

  #eventStream: EventStream | null = null
  #pollTimer: NodeJS.Timeout | null = null
  #keepAliveTimer: NodeJS.Timeout | null = null
  #refreshTimer: NodeJS.Timeout | null = null
  /** Interrupts a pending initial-discovery backoff when Homebridge shuts down. */
  #startupRetryResolve: (() => void) | null = null
  #pendingRefreshIds = new Set<string>()
  #systemId: string | null = null
  #isShuttingDown = false
  /**
   * Cancels in-flight network work at shutdown.
   *
   * Without it, clearing the timers only stopped *new* work: a request already
   * in flight ran to its 30-second deadline, then its retries, then their
   * backoff, all against a platform that was supposed to be gone.
   */
  readonly #abortController = new AbortController()
  /** Prevents stacked poll cycles when a refresh outlasts the poll interval. */
  #refreshAllInFlight = false
  /** When the account was last re-enumerated, driving periodic rediscovery. */
  #lastDiscoveryAt = 0
  /** Consecutive failures, for escalating a sustained outage and noting recovery. */
  #consecutiveFailures = 0
  #hasWarnedAboutOutage = false
  /** Last user-actionable failure reported loudly, so it is not repeated. */
  #lastReportedError: string | null = null

  constructor(log: Logging, config: MyAlarmComPlatformConfig, api: API) {
    this.api = api
    this.Service = api.hap.Service
    this.Characteristic = api.hap.Characteristic
    this.#rawLog = log

    const { config: resolved, warnings, errors } = validateConfig(config)
    this.#config = resolved ?? DISABLED_CONFIG

    // Routed through the scoped logger rather than the raw Homebridge one so
    // the "every line is redacted" guarantee holds without exception. Config
    // messages quote user-supplied values, which is precisely where a
    // mistakenly pasted secret would surface.
    this.#log = createScopedLogger(log, 'platform', this.#config.debug)
    this.#partitionLog = createScopedLogger(log, 'partition', this.#config.debug)

    for (const warning of warnings) {
      this.#log.warn(warning)
    }
    for (const error of errors) {
      this.#log.error(error)
    }

    // Counters always accumulate; heartbeats are only emitted when
    // diagnosticsInterval > 0.
    this.#diagnostics = new DiagnosticsCollector({
      pluginVersion: PLUGIN_VERSION,
      config: this.#config,
    })
    this.#reporter = new DiagnosticsReporter({
      collector: this.#diagnostics,
      readers: this.#buildDiagnosticsReaders(),
      log: createScopedLogger(log, 'diagnostics', this.#config.debug),
      intervalMs: this.#config.diagnosticsInterval * MS_PER_SECOND,
    })

    if (!resolved) {
      this.#log.error(
        `${PLATFORM_NAME} is not starting because its configuration is unusable. `
        + 'Fix the problems above and restart Homebridge; the rest of your bridge is unaffected.',
      )
      this.#client = null
      this.#sessionManager = null
      return
    }

    this.#sessionManager = new SessionManager({
      credentials: {
        username: resolved.username,
        password: resolved.password,
        twoFactorAuthenticationId: resolved.twoFactorAuthenticationId,
      },
      authIntervalMinutes: resolved.authIntervalMinutes,
      log: createScopedLogger(log, 'auth', resolved.debug),
      onSessionEstablished: () => this.#diagnostics.sessionLogin(),
      signal: this.#abortController.signal,
    })

    this.#client = new AlarmComClient({
      sessionManager: this.#sessionManager,
      log: createScopedLogger(log, 'api', resolved.debug),
      metrics: (sample) =>
        this.#diagnostics.apiRequest(sample.durationMs, sample.isOk, sample.wasNetworked),
      onCircuitOpen: () => this.#diagnostics.breakerTrip(),
      onThrottle: () => this.#diagnostics.throttle(),
      onRetry: () => this.#diagnostics.retry(),
      signal: this.#abortController.signal,
    })

    api.on('didFinishLaunching', () => {
      // Nothing in #start rejects today, but an unhandled rejection here would
      // terminate the bridge rather than log, so the guarantee is enforced
      // rather than assumed.
      this.#start().catch((error: unknown) => this.#reportFailure('Startup failed', error))
    })
    api.on('shutdown', () => this.#shutdown())
  }

  /**
   * The API client, used by accessories to issue commands.
   *
   * Only reachable once the configuration is usable: an unusable one publishes
   * no accessories, so there is nothing to call this.
   */
  get client(): AlarmComClient {
    if (!this.#client) {
      throw new ConfigurationError(`${PLATFORM_NAME} has no usable configuration`)
    }
    return this.#client
  }

  /** Homebridge replays cached accessories here on startup. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.#cachedAccessories.set(accessory.UUID, accessory)
  }

  async #start(): Promise<void> {
    const sessionManager = this.#sessionManager
    if (!sessionManager) {
      return
    }

    if (!(await this.#awaitInitialDiscovery())) {
      // INFO start waits until Ready so it is not a wall of zeros. A permanent
      // boot failure still gets a debug snapshot (config echo) when diagnostics
      // and debug logging are both on.
      this.#reporter.noteBootFailure()
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

    this.#log.info('Platform Ready')
    // After Ready: devices and stream state are real, so the start line is useful.
    this.#reporter.start()
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
        await this.#discover({ reason: 'startup' })
        return true
      } catch (error) {
        // Re-checked here, not only at the top of the loop. Shutdown aborts the
        // in-flight discovery, which surfaces as a retryable error — so without
        // this the log ended with "Retrying in 5s" immediately before never
        // retrying.
        if (this.#isShuttingDown) {
          return false
        }

        const detail = sanitizeError(error)
        const delayMs = initialDiscoveryRetryDelayMs(error, attempt + 1)

        if (delayMs === null) {
          this.#log.error(
            `Initial discovery failed and will not be retried: ${detail}. `
            + 'Correct the problem and restart Homebridge.',
          )
          return false
        }

        attempt++
        this.#log.warn(
          `Initial discovery failed: ${detail}. Retrying in ${Math.round(delayMs / MS_PER_SECOND)}s.`,
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
      let isSettled = false
      const finish = (hasContinued: boolean): void => {
        if (isSettled) {
          return
        }
        isSettled = true
        this.#startupRetryResolve = null
        resolve(hasContinued)
      }

      this.#startupRetryResolve = () => finish(false)
      // The shared sleep helper cancels on abort and unrefs its timer, so a
      // five-minute discovery backoff cannot hold the process open at shutdown.
      sleep(ms, this.#abortController.signal)
        .then(() => finish(!this.#isShuttingDown))
        .catch(() => finish(false))
    })
  }

  /**
   * Enumerate the account's devices and publish them to HomeKit.
   *
   * @param options.reason - `startup` logs the inventory at info; `periodic`
   *   is the hourly re-check for panel add/remove and stays at debug unless a
   *   later sync step itself logs an add/remove.
   */
  async #discover(options: { reason: 'startup' | 'periodic', signal?: AbortSignal }): Promise<void> {
    // Stamped before the work, not after. Recording only successful runs meant
    // a failing rediscovery was still due on the very next poll, so an account
    // that could not be enumerated was re-enumerated every interval instead of
    // hourly. That is the traffic pattern Alarm.com locks accounts for, and it
    // also displaced the ordinary refresh, so HomeKit went stale as well.
    this.#lastDiscoveryAt = Date.now()

    const { reason, signal } = options

    this.#systemId ??= await this.client.getSystemId(signal)
    const devices = await this.client.getSystemDevices(this.#systemId, signal)

    this.#logInventory(devices, reason)

    // Pruned as soon as the authoritative list is in hand, before the detail
    // reads that can still fail. Leaving it to the end meant a failure part
    // way through discarded what was already known, and a device deleted at
    // the panel went on being polled until a whole interval later.
    this.#reconcileKnownDevices(devices)

    // Unregister HomeKit accessories for devices deleted at the panel (and for
    // explicitly ignored IDs) immediately, so a later detail-read failure
    // cannot leave ghosts until the next hourly rediscovery.
    const requestedPartitionIds = this.#withoutIgnored(devices.partitionIds)
    const requestedSensorIds = this.#withoutIgnored(devices.sensorIds)
    this.#removeStaleAccessories(new Set([...requestedPartitionIds, ...requestedSensorIds]))

    await this.#publishDevices(requestedPartitionIds, requestedSensorIds, reason, signal)
  }

  #withoutIgnored(deviceIds: readonly string[]): string[] {
    return deviceIds.filter((id) => !this.#config.ignoredDeviceIds.has(id))
  }

  #logInventory(devices: SystemDevices, reason: 'startup' | 'periodic'): void {
    const inventory =
      `${devices.partitionIds.length} partition(s) and ${devices.sensorIds.length} sensor(s)`

    if (reason === 'startup') {
      this.#log.info(`Discovered ${inventory}`)
      return
    }
    // Routine hourly re-enumeration; real add/remove still logs at info via
    // Adding… / Removing… below.
    this.#log.debug(`Rediscovering devices to detect panel add/remove changes: ${inventory}`)
  }

  /**
   * Read device detail and sync each device into HomeKit.
   *
   * A device whose detail read came back empty is kept, not unregistered.
   * Inferring "gone" from "no handler" meant a partial response on the very
   * first discovery deleted accessories that were still on the account, and
   * unregistering is not cosmetic — HomeKit loses the room, the name, and
   * every automation bound to that accessory.
   */
  async #publishDevices(
    partitionIds: string[],
    sensorIds: string[],
    reason: 'startup' | 'periodic',
    signal?: AbortSignal,
  ): Promise<void> {
    const partitions = await this.client.getPartitions(partitionIds, signal)
    const sensors = await this.client.getSensors(sensorIds, signal)

    const read = new Set<string>()
    /** Read successfully but deliberately not published, by policy. */
    const skipped = new Set<string>()

    for (const partition of partitions) {
      this.#syncPartition(partition)
      read.add(partition.id)
    }
    for (const sensor of sensors) {
      if (!this.#syncSensor(sensor, reason)) {
        skipped.add(sensor.id)
      }
      read.add(sensor.id)
    }

    const unreadable = [...partitionIds, ...sensorIds].filter((id) => !read.has(id))
    if (unreadable.length > 0) {
      this.#log.warn(
        `Alarm.com returned no detail for ${unreadable.length} device(s); keeping their HomeKit accessories until it does.`,
      )
    }

    // Prune devices that were read but deliberately not published, keeping the
    // unreadable ones. `skipped` is passed separately so the removal line can
    // say *why* — "no longer on the account" is false for a device the plugin
    // simply declined to publish.
    this.#removeStaleAccessories(
      new Set([...this.#partitions.keys(), ...this.#sensors.keys(), ...unreadable]),
      skipped,
    )
  }

  /** Find or create the accessory for a device, restoring from cache if present. */
  #resolveAccessory(
    deviceId: string,
    displayName: string,
    context: AccessoryContext,
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
      handler = new PartitionAccessory(this, accessory, this.#partitionLog)
      this.#partitions.set(deviceId, handler)
    }

    if (isNew) {
      this.#log.info(`Adding security system "${displayName}" (${deviceId})`)
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
    }

    handler.updateName(displayName)
    handler.update(resource)
  }

  /**
   * Publish one sensor, or decline to.
   *
   * @returns Whether it was published. A `false` return is a policy decision,
   *   not a failure.
   */
  #syncSensor(resource: Resource<SensorAttributes>, reason: 'startup' | 'periodic'): boolean {
    const deviceId = resource.id
    const attributes = resource.attributes
    const kind = toSensorServiceKind(attributes.deviceType)
    // Responses are parsed without runtime validation, so an absent or renamed
    // `description` arrives as undefined. HAP rejects an accessory with no
    // name, and on first discovery that throw is what ends startup.
    const displayName = attributes.description ?? `Sensor ${deviceId}`

    // Announced on the first discovery that sees it, then quiet. Discovery runs
    // hourly, and a panel commonly carries several unsupported or unmonitored
    // devices, so an unconditional info line was a permanent hourly drip about
    // a decision that never changes.
    const announce = (message: string): void => {
      if (reason === 'startup' || !this.#reportedSkips.has(deviceId)) {
        this.#reportedSkips.add(deviceId)
        this.#log.info(message)
      } else {
        this.#log.debug(message)
      }
    }

    if (!kind) {
      announce(
        `Skipping "${displayName}" (${deviceId}): Alarm.com device type ${String(attributes.deviceType)} is not supported yet.`,
      )
      // Drop a previously published handler so post-sync stale removal can
      // unregister the HomeKit accessory on a live rediscovery.
      this.#forgetSensor(deviceId)
      return false
    }

    if (attributes.isMonitoringEnabled === false && !this.#config.includeUnmonitoredSensors) {
      announce(
        `Skipping "${displayName}" (${deviceId}): Alarm.com reports monitoring is disabled. Set "includeUnmonitoredSensors" to expose it anyway.`,
      )
      this.#forgetSensor(deviceId)
      return false
    }

    this.#reportedSkips.delete(deviceId)

    const { accessory, isNew } = this.#resolveAccessory(deviceId, displayName, {
      deviceId,
      kind,
      displayName,
    })

    this.#applyAccessoryInformation(accessory, deviceId, attributes.manufacturer ?? `${kind} sensor`)

    let handler = this.#sensors.get(deviceId)
    if (!handler) {
      handler = new SensorAccessory(this, accessory, kind, this.#sensorLog(kind))
      this.#sensors.set(deviceId, handler)
    }

    if (isNew) {
      this.#log.info(`Adding ${kind} sensor "${displayName}" (${deviceId})`)
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
    }

    handler.updateName(displayName)
    handler.update(resource)
    return true
  }

  #sensorLog(kind: SensorServiceKind): Logger {
    const existing = this.#sensorLogs.get(kind)
    if (existing) {
      return existing
    }
    const created = createScopedLogger(this.#rawLog, kind, this.#config.debug)
    this.#sensorLogs.set(kind, created)
    return created
  }

  /** Stop tracking a sensor and cancel any timer it owns. */
  #forgetSensor(deviceId: string): void {
    this.#sensors.get(deviceId)?.dispose()
    this.#sensors.delete(deviceId)
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

    for (const deviceId of [...this.#partitions.keys()]) {
      if (!reported.has(deviceId)) {
        this.#partitions.delete(deviceId)
      }
    }
    for (const deviceId of [...this.#sensors.keys()]) {
      if (!reported.has(deviceId)) {
        this.#forgetSensor(deviceId)
      }
    }
  }

  /**
   * Unregister accessories the plugin is no longer publishing.
   *
   * @param skippedIds Devices still on the account that this plugin declined to
   *   publish. They are removed too, but saying "no longer on the account" about
   *   them would be untrue and would send the user looking at their panel.
   */
  #removeStaleAccessories(
    liveIds: ReadonlySet<string>,
    skippedIds: ReadonlySet<string> = new Set(),
  ): void {
    for (const [uuid, accessory] of this.#cachedAccessories) {
      const deviceId = (accessory.context as Partial<AccessoryContext>).deviceId

      if (deviceId !== undefined && liveIds.has(deviceId)) {
        continue
      }

      const reason = deviceId !== undefined && skippedIds.has(deviceId)
        ? 'which this plugin is not publishing'
        : 'which is no longer on the account'
      this.#log.info(`Removing "${accessory.displayName}", ${reason}`)
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
      this.#cachedAccessories.delete(uuid)
    }
  }

  #startPolling(): void {
    if (this.#isShuttingDown || this.#pollTimer) {
      return
    }
    const intervalMs = this.#config.pollIntervalSeconds * MS_PER_SECOND
    this.#pollTimer = setInterval(() => {
      void this.#refreshAll()
    }, intervalMs)
    // Unref'd like every other timer here: they are cleared on shutdown, but if
    // that event never arrives an interval is what keeps a child bridge alive
    // looking like a hang.
    this.#pollTimer.unref?.()
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
      sessionManager.touch()
        .then((isAlive) => {
          if (!isAlive) {
            this.#log.debug('Session keep-alive did not confirm a live session')
          }
        })
        .catch((error: unknown) => {
          this.#log.debug(`Session keep-alive tick failed: ${sanitizeError(error)}`)
        })
    }, KEEPALIVE_INTERVAL_MS)
    this.#keepAliveTimer.unref?.()
  }

  async #startEventStream(): Promise<void> {
    if (this.#isShuttingDown) {
      return
    }
    this.#eventStream = new EventStream({
      log: createScopedLogger(this.#rawLog, 'events', this.#config.debug),
      requestToken: () => this.client.getEventStreamToken(),
      onDeviceEvent: (deviceId, event) => this.#handleDeviceEvent(deviceId, event),
      onUnavailable: () => {
        this.#log.warn('Continuing with polling only; HomeKit updates will be slower.')
      },
      onReconnect: () => this.#diagnostics.wsReconnect(),
      // Counted, not logged. The stream itself reports recovery at info in words
      // that mean something to a user; a second "recovery recorded" line here
      // said nothing while making the failure/recovery pair look mismatched.
      onRecovered: () => this.#diagnostics.wsReconnect(),
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
      sensor.applyImmediateState(hint.isTriggered, hint.isTransient)
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
    // Unlike the timer starters, this is reachable from outside: a HomeKit
    // write or a stream frame delivered mid-teardown would otherwise re-arm a
    // timer that #shutdown had just cleared, and run a network refresh against
    // a platform that is supposed to be gone.
    if (this.#isShuttingDown) {
      return
    }

    this.#pendingRefreshIds.add(deviceId)

    if (this.#refreshTimer) {
      return
    }

    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null
      const ids = [...this.#pendingRefreshIds]
      this.#pendingRefreshIds.clear()
      this.#refreshDevices(ids)
        // Recovery is noted wherever it happens, not only on the poll cycle: an
        // event-driven refresh proves Alarm.com is reachable just as well. But
        // only when it actually read something — a frame for an ignored or
        // unsupported device issues no request at all, and reporting that as
        // "reachable again" told the user the opposite of the truth during an
        // API outage that the stream had survived.
        .then((refreshed) => {
          if (refreshed > 0) {
            this.#reportSuccess()
          }
        })
        .catch((error: unknown) => {
          this.#reportFailure(`Targeted refresh of ${ids.length} device(s) failed`, error)
        })
    }, REFRESH_DEBOUNCE_MS)
    this.#refreshTimer.unref?.()
  }

  /**
   * Re-read a specific set of devices and push their state to HomeKit.
   *
   * @returns How many devices were actually read. Zero means no request was
   *   made, which matters because the caller must not read that as evidence
   *   that Alarm.com is reachable.
   */
  async #refreshDevices(deviceIds: readonly string[], signal?: AbortSignal): Promise<number> {
    const partitionIds: string[] = []
    const sensorIds: string[] = []

    for (const id of deviceIds) {
      if (this.#partitions.has(id)) {
        partitionIds.push(id)
      } else if (this.#sensors.has(id)) {
        sensorIds.push(id)
      }
    }

    if (partitionIds.length === 0 && sensorIds.length === 0) {
      return 0
    }

    for (const resource of await this.client.getPartitions(partitionIds, signal)) {
      this.#partitions.get(resource.id)?.update(resource)
    }
    for (const resource of await this.client.getSensors(sensorIds, signal)) {
      this.#sensors.get(resource.id)?.update(resource)
    }

    return partitionIds.length + sensorIds.length
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
    let devicesRefreshed = 0
    let didFail = false

    try {
      devicesRefreshed = await this.#withCycleDeadline(
        (signal) => this.#runRefreshCycle(isRediscoveryDue, signal),
      )
      if (devicesRefreshed > 0) {
        this.#reportSuccess()
      }
    } catch (error) {
      didFail = true
      this.#reportFailure(isRediscoveryDue ? 'Rediscovery failed' : 'Poll failed', error)
    } finally {
      this.#refreshAllInFlight = false
      this.#diagnostics.pollCycle(didFail ? 0 : 1, didFail ? 1 : 0, Date.now() - started)
    }
  }

  async #runRefreshCycle(isRediscoveryDue: boolean, signal: AbortSignal): Promise<number> {
    if (isRediscoveryDue) {
      await this.#discover({ reason: 'periodic', signal })
      return this.#partitions.size + this.#sensors.size
    }

    return this.#refreshDevices([...this.#partitions.keys(), ...this.#sensors.keys()], signal)
  }

  /**
   * Bound a whole poll cycle, not just the requests inside it.
   *
   * `#refreshAllInFlight` is only cleared in a `finally`, so a cycle that never
   * settles stops all polling for the life of the process — silently, because
   * the interval keeps firing and keeps returning early. Per-request deadlines
   * do not cover this: a cycle is many requests plus pacing plus backoff.
   *
   * The deadline *cancels* rather than merely stops waiting. Abandoning the
   * promise cleared the in-flight guard while the original cycle kept issuing
   * requests, so at the minimum poll interval up to five cycles could overlap —
   * each one slowing the others through the shared pacing queue, and each one
   * able to register and unregister accessories underneath a newer cycle.
   */
  async #withCycleDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const cycle = new AbortController()
    const abortCycle = (): void => cycle.abort()
    this.#abortController.signal.addEventListener('abort', abortCycle, { once: true })

    const timer = setTimeout(abortCycle, POLL_CYCLE_DEADLINE_MS)
    timer.unref?.()

    try {
      return await operation(cycle.signal)
    } finally {
      clearTimeout(timer)
      this.#abortController.signal.removeEventListener('abort', abortCycle)
      // Unconditional: a cycle that returned normally must not leave anything
      // it spawned still running.
      cycle.abort()
    }
  }

  /**
   * Log a failure at a level matching whether the user can act on it.
   *
   * Transient trouble is logged quietly; a bad password or a stale two-factor
   * cookie is logged loudly, because nothing will improve until it is fixed.
   *
   * Repetition is what turns a quiet failure into a loud one. Every retryable
   * error routes to debug, which is off by default, so a sustained outage used
   * to produce no output at all while HomeKit silently went stale.
   */
  #reportFailure(context: string, error: unknown): void {
    const detail = sanitizeError(error)

    // User-actionable problems are rare and never self-heal, so they are loud —
    // but only once per distinct problem. A rejected password re-raises on every
    // poll cycle without touching the network, which at the default interval was
    // 1,440 identical error lines a day saying nothing the first did not.
    if (failureLogLevel(error) === 'error') {
      const signature = `${context}: ${detail}`
      if (signature !== this.#lastReportedError) {
        this.#lastReportedError = signature
        this.#log.error(signature)
      } else {
        this.#log.debug(signature)
      }
      return
    }

    // Counted only for failures that may clear on their own, which is what the
    // outage summary below is about.
    this.#consecutiveFailures++
    this.#log.debug(`${context}: ${detail}`)

    // Counted regardless of which error arrived, because the error *type*
    // changes during a real outage: the first few are network or 5xx failures,
    // and once the circuit breaker opens they become CircuitBreakerError. A
    // counter keyed on the message would reset at exactly that point and never
    // reach the threshold.
    if (this.#consecutiveFailures >= POLL_FAILURE_WARN_THRESHOLD && !this.#hasWarnedAboutOutage) {
      this.#hasWarnedAboutOutage = true
      this.#log.warn(
        `Alarm.com has failed ${this.#consecutiveFailures} times in a row (most recently: ${detail}). `
        + 'HomeKit state may be stale until it is reachable again.',
      )
    }
  }

  /** Note that the operation is working again, pairing with {@link #reportFailure}. */
  #reportSuccess(): void {
    if (this.#hasWarnedAboutOutage) {
      this.#log.info('Alarm.com is reachable again; HomeKit state is up to date.')
    }
    this.#consecutiveFailures = 0
    this.#hasWarnedAboutOutage = false
    this.#lastReportedError = null
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
    const byType: Partial<Record<SensorServiceKind, number>> = {}

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

  #shutdown(): void {
    if (this.#isShuttingDown) {
      return
    }
    this.#isShuttingDown = true

    const resolveStartupRetry = this.#startupRetryResolve
    this.#startupRetryResolve = null
    resolveStartupRetry?.()

    // Cancel in-flight work before clearing timers, so a request that is
    // already out cannot outlive the platform by its full retry budget.
    this.#abortController.abort()

    this.#reporter.stop()

    if (this.#pollTimer) {
      clearInterval(this.#pollTimer)
      this.#pollTimer = null
    }
    if (this.#keepAliveTimer) {
      clearInterval(this.#keepAliveTimer)
      this.#keepAliveTimer = null
    }
    if (this.#refreshTimer) {
      clearTimeout(this.#refreshTimer)
      this.#refreshTimer = null
    }
    this.#pendingRefreshIds.clear()

    for (const sensor of this.#sensors.values()) {
      sensor.dispose()
    }

    this.#eventStream?.stop()
    this.#eventStream = null
  }
}
