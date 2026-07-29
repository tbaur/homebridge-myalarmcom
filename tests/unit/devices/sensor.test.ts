/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * These run against real HAP services, so a characteristic that does not belong
 * on a service, or a value HAP would reject, fails here rather than in
 * somebody's Home app.
 */

import { Characteristic, Service } from '@homebridge/hap-nodejs'
import { SensorAccessory, type SensorAccessoryContext } from '../../../src/devices/sensor'
import type { Resource, SensorAttributes } from '../../../src/types/alarm'
import type { SensorServiceKind } from '../../../src/utils/mappers'
import {
  characteristicValue,
  createPlatformTestBed,
  servicesOf,
  type PlatformTestBed,
} from '../../helpers/homekit'
import { createRecordingLogger, messagesAt, type RecordingLogger } from '../../helpers/logger'
import sensorsFixture from '../../fixtures/sensors.json'

const sensors = sensorsFixture.data as unknown as Resource<SensorAttributes>[]

function sensorNamed(description: string): Resource<SensorAttributes> {
  const match = sensors.find((sensor) => sensor.attributes.description === description)
  if (!match) {
    throw new Error(`No sensor named "${description}" in the fixture`)
  }
  return match
}

function withAttributes(
  resource: Resource<SensorAttributes>,
  overrides: Partial<SensorAttributes>,
): Resource<SensorAttributes> {
  return { ...resource, attributes: { ...resource.attributes, ...overrides } }
}

describe('SensorAccessory', () => {
  let log: RecordingLogger
  let bed: PlatformTestBed

  function mount(resource: Resource<SensorAttributes>, kind: SensorServiceKind): SensorAccessory {
    const context: SensorAccessoryContext = {
      deviceId: resource.id,
      kind,
      displayName: resource.attributes.description,
    }
    bed = createPlatformTestBed(context as unknown as Record<string, unknown>)
    return new SensorAccessory(bed.platform, bed.accessory, kind, log)
  }

  function service(): Service {
    return servicesOf(bed.accessory)[0]
  }

  function valueOf(target: { UUID: string }): unknown {
    return characteristicValue(service(), target)
  }

  beforeEach(() => {
    log = createRecordingLogger()
  })

  describe('service selection', () => {
    it('publishes a contact sensor service for a contact device', () => {
      mount(sensorNamed('Front Door'), 'contact')

      expect(service().UUID).toBe(Service.ContactSensor.UUID)
    })

    it('publishes a motion sensor service for a motion device', () => {
      mount(sensorNamed('Hallway Motion'), 'motion')

      expect(service().UUID).toBe(Service.MotionSensor.UUID)
    })

    it('publishes a smoke sensor service for a smoke device', () => {
      mount(sensorNamed('Upstairs Smoke'), 'smoke')

      expect(service().UUID).toBe(Service.SmokeSensor.UUID)
    })

    it('names the service after the Alarm.com description', () => {
      mount(sensorNamed('Front Door'), 'contact')

      expect(valueOf(Characteristic.Name)).toBe('Front Door')
    })

    it('reuses a service restored from the accessory cache', () => {
      const accessory = mount(sensorNamed('Front Door'), 'contact')
      const first = service()

      const second = new SensorAccessory(bed.platform, bed.accessory, 'contact', log)
      second.update(sensorNamed('Front Door'))

      expect(servicesOf(bed.accessory)).toHaveLength(1)
      expect(accessory.deviceId).toBe('1234567-1')
      expect(service()).toBe(first)
    })
  })

  describe('update', () => {
    it('reports a closed contact sensor as contact detected', () => {
      const accessory = mount(sensorNamed('Front Door'), 'contact')

      accessory.update(sensorNamed('Front Door'))

      expect(valueOf(Characteristic.ContactSensorState))
        .toBe(Characteristic.ContactSensorState.CONTACT_DETECTED)
    })

    it('reports an open contact sensor as contact not detected', () => {
      const accessory = mount(sensorNamed('Kitchen Window'), 'contact')

      accessory.update(sensorNamed('Kitchen Window'))

      expect(valueOf(Characteristic.ContactSensorState))
        .toBe(Characteristic.ContactSensorState.CONTACT_NOT_DETECTED)
    })

    it('reports an activated motion sensor as motion detected', () => {
      const accessory = mount(sensorNamed('Hallway Motion'), 'motion')

      accessory.update(sensorNamed('Hallway Motion'))

      expect(valueOf(Characteristic.MotionDetected)).toBe(true)
    })

    it('does not treat a smoke detector at rest as an alarm', () => {
      const accessory = mount(sensorNamed('Upstairs Smoke'), 'smoke')

      accessory.update(sensorNamed('Upstairs Smoke'))

      expect(valueOf(Characteristic.SmokeDetected))
        .toBe(Characteristic.SmokeDetected.SMOKE_NOT_DETECTED)
    })

    it('reports a tripped smoke detector', () => {
      const resource = sensorNamed('Upstairs Smoke')
      const accessory = mount(resource, 'smoke')

      accessory.update(withAttributes(resource, { state: 4, openClosedStatus: 3 }))

      expect(valueOf(Characteristic.SmokeDetected))
        .toBe(Characteristic.SmokeDetected.SMOKE_DETECTED)
    })

    it('marks a sensor inactive when Alarm.com is not monitoring it', () => {
      const resource = sensorNamed('Front Door')
      const accessory = mount(resource, 'contact')

      accessory.update(withAttributes(resource, { isMonitoringEnabled: false }))

      expect(valueOf(Characteristic.StatusActive)).toBe(false)
    })

    it('treats an unreported monitoring flag as monitored', () => {
      const resource = sensorNamed('Front Door')
      const accessory = mount(resource, 'contact')

      accessory.update(withAttributes(resource, { isMonitoringEnabled: undefined }))

      expect(valueOf(Characteristic.StatusActive)).toBe(true)
    })

    it('raises a fault for a malfunctioning sensor', () => {
      const resource = sensorNamed('Front Door')
      const accessory = mount(resource, 'contact')

      accessory.update(withAttributes(resource, { isMalfunctioning: true }))

      expect(valueOf(Characteristic.StatusFault)).toBe(Characteristic.StatusFault.GENERAL_FAULT)
    })

    it('clears the fault when the sensor recovers', () => {
      const resource = sensorNamed('Front Door')
      const accessory = mount(resource, 'contact')

      accessory.update(withAttributes(resource, { isMalfunctioning: true }))
      accessory.update(withAttributes(resource, { isMalfunctioning: false }))

      expect(valueOf(Characteristic.StatusFault)).toBe(Characteristic.StatusFault.NO_FAULT)
    })

    it('leaves the previous reading alone when the device type is unsupported', () => {
      const resource = sensorNamed('Front Door')
      const accessory = mount(resource, 'contact')
      accessory.update(withAttributes(resource, { state: 2, openClosedStatus: 3 }))

      accessory.update(withAttributes(resource, { deviceType: 6 }))

      expect(valueOf(Characteristic.ContactSensorState))
        .toBe(Characteristic.ContactSensorState.CONTACT_NOT_DETECTED)
      expect(messagesAt(log, 'warn').join('\n')).toMatch(/unsupported device type 6/)
    })

    it('warns about a reading it cannot reconcile, and says what it assumed', () => {
      const resource = sensorNamed('Front Door')
      const accessory = mount(resource, 'contact')

      accessory.update(withAttributes(resource, { state: 1, openClosedStatus: 3 }))

      const warning = messagesAt(log, 'warn').join('\n')
      expect(warning).toMatch(/does not recognise as a matched pair/)
      expect(warning).toMatch(/Treating it as "Closed"/)
      expect(warning).toMatch(/please report this/)
    })

    it('stays quiet about a reading that reconciles', () => {
      const accessory = mount(sensorNamed('Front Door'), 'contact')

      accessory.update(sensorNamed('Front Door'))

      expect(log.warn).not.toHaveBeenCalled()
    })

    it('logs the label Alarm.com itself would display', () => {
      const accessory = mount(sensorNamed('Kitchen Window'), 'contact')

      accessory.update(sensorNamed('Kitchen Window'))

      expect(messagesAt(log, 'debug')).toContain('Kitchen Window is Open')
    })
  })

  describe('applyImmediateState', () => {
    it('opens a contact sensor without waiting for a reading', () => {
      const accessory = mount(sensorNamed('Front Door'), 'contact')

      accessory.applyImmediateState(true)

      expect(valueOf(Characteristic.ContactSensorState))
        .toBe(Characteristic.ContactSensorState.CONTACT_NOT_DETECTED)
    })

    it('closes a contact sensor without waiting for a reading', () => {
      const resource = sensorNamed('Front Door')
      const accessory = mount(resource, 'contact')
      accessory.update(withAttributes(resource, { state: 2, openClosedStatus: 3 }))

      accessory.applyImmediateState(false)

      expect(valueOf(Characteristic.ContactSensorState))
        .toBe(Characteristic.ContactSensorState.CONTACT_DETECTED)
    })

    it('is overridden by the reading that follows it', () => {
      // The immediate value is a guess and the read is authoritative, so a
      // momentary open must not survive a reading that says otherwise.
      const resource = sensorNamed('Front Door')
      const accessory = mount(resource, 'contact')

      accessory.applyImmediateState(true)
      accessory.update(resource)

      expect(valueOf(Characteristic.ContactSensorState))
        .toBe(Characteristic.ContactSensorState.CONTACT_DETECTED)
    })

    it('triggers a motion sensor', () => {
      const accessory = mount(sensorNamed('Hallway Motion'), 'motion')

      accessory.applyImmediateState(true)

      expect(valueOf(Characteristic.MotionDetected)).toBe(true)
    })

    it('triggers a smoke detector', () => {
      const accessory = mount(sensorNamed('Upstairs Smoke'), 'smoke')

      accessory.applyImmediateState(true)

      expect(valueOf(Characteristic.SmokeDetected))
        .toBe(Characteristic.SmokeDetected.SMOKE_DETECTED)
    })
  })
})
