/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Homebridge test doubles built on the real HAP implementation.
 *
 * Only the Homebridge shell (accessory registration, the plugin lifecycle
 * events) is faked. Services and characteristics are the genuine hap-nodejs
 * classes, so characteristic validation, permissions, and HAP status codes
 * behave in tests exactly as they do in a running Homebridge instance.
 */

import { EventEmitter } from 'node:events'
import {
  Characteristic,
  HapStatusError,
  Perms,
  Service,
  uuid,
} from '@homebridge/hap-nodejs'
import type { API, Logging, PlatformAccessory } from 'homebridge'
import type { MyAlarmComPlatform } from '../../src/platform'

/** The shape accessories rely on when asking for a service by type. */
type ServiceConstructor = { UUID: string } & (new (displayName?: string, subtype?: string) => Service)

/**
 * The permission values the partition accessory reads off `api.hap`.
 *
 * HAP declares `Perms` as a const enum, so it cannot be passed around as an
 * object; the members are spelled out to keep the values tied to HAP anyway.
 */
const PERMS = { PAIRED_READ: Perms.PAIRED_READ, NOTIFY: Perms.NOTIFY }

/** Stand-in for Homebridge's `PlatformAccessory`, holding real HAP services. */
export class FakePlatformAccessory {
  readonly services: Service[] = []
  context: Record<string, unknown> = {}

  constructor(readonly displayName: string, readonly UUID: string) {}

  getService(target: ServiceConstructor): Service | undefined {
    return this.services.find((service) => service.UUID === target.UUID)
  }

  addService(target: ServiceConstructor, ...args: [string?, string?]): Service {
    const service = new target(...args)
    this.services.push(service)
    return service
  }
}

/** The services an accessory has published, in the order they were added. */
export function servicesOf(accessory: PlatformAccessory): Service[] {
  return (accessory as unknown as FakePlatformAccessory).services
}

/** The current value of one characteristic on a service, found by HAP UUID. */
export function characteristicValue(service: Service, target: { UUID: string }): unknown {
  const characteristic = service.characteristics.find((entry) => entry.UUID === target.UUID)
  if (!characteristic) {
    throw new Error(`The service is not publishing the characteristic ${target.UUID}`)
  }
  return characteristic.value
}

/** A platform stub carrying just what the accessory classes reach for. */
export interface PlatformTestBed {
  platform: MyAlarmComPlatform
  accessory: PlatformAccessory
  commandPartition: jest.Mock
  requestDeviceRefresh: jest.Mock
  recordCommand: jest.Mock
}

export function createPlatformTestBed(context: Record<string, unknown>): PlatformTestBed {
  const commandPartition = jest.fn()
  const requestDeviceRefresh = jest.fn()
  const recordCommand = jest.fn()

  const accessory = new FakePlatformAccessory(String(context.displayName), 'fake-uuid')
  accessory.context = context

  const platform = {
    Service,
    Characteristic,
    api: { hap: { uuid, Perms: PERMS, HapStatusError } },
    client: { commandPartition },
    requestDeviceRefresh,
    recordCommand,
  } as unknown as MyAlarmComPlatform

  return {
    platform,
    accessory: accessory as unknown as PlatformAccessory,
    commandPartition,
    requestDeviceRefresh,
    recordCommand,
  }
}

/** A Homebridge `API` double recording everything the platform publishes. */
export class FakeHomebridgeApi extends EventEmitter {
  readonly hap = { Service, Characteristic, uuid, Perms: PERMS, HapStatusError }
  readonly platformAccessory = FakePlatformAccessory

  readonly registered: FakePlatformAccessory[] = []
  readonly unregistered: FakePlatformAccessory[] = []
  readonly updated: FakePlatformAccessory[] = []

  registerPlatformAccessories(
    _plugin: string,
    _platform: string,
    accessories: FakePlatformAccessory[],
  ): void {
    this.registered.push(...accessories)
  }

  unregisterPlatformAccessories(
    _plugin: string,
    _platform: string,
    accessories: FakePlatformAccessory[],
  ): void {
    this.unregistered.push(...accessories)
  }

  updatePlatformAccessories(accessories: FakePlatformAccessory[]): void {
    this.updated.push(...accessories)
  }

  /** Names of everything published to HomeKit, in registration order. */
  get registeredNames(): string[] {
    return this.registered.map((accessory) => accessory.displayName)
  }

  asApi(): API {
    return this as unknown as API
  }
}

/** Homebridge's `Logging`, which is a callable object with level methods. */
export type RecordingLogging = Logging & {
  debugMessages: string[]
  infoMessages: string[]
  warnings: string[]
  errors: string[]
}

export function createHomebridgeLogging(): RecordingLogging {
  const debugMessages: string[] = []
  const infoMessages: string[] = []
  const warnings: string[] = []
  const errors: string[] = []

  const log = (() => undefined) as unknown as RecordingLogging

  log.debug = (message: string) => {
    debugMessages.push(message)
  }
  log.info = (message: string) => {
    infoMessages.push(message)
  }
  log.warn = (message: string) => {
    warnings.push(message)
  }
  log.error = (message: string) => {
    errors.push(message)
  }
  log.log = () => undefined
  log.success = () => undefined
  log.debugMessages = debugMessages
  log.infoMessages = infoMessages
  log.warnings = warnings
  log.errors = errors

  return log
}

/**
 * Poll until a condition holds.
 *
 * Homebridge starts discovery from a fire-and-forget `didFinishLaunching`
 * handler, so there is no promise for a test to await.
 */
export async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 5_000, description = 'condition' }: { timeoutMs?: number, description?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
