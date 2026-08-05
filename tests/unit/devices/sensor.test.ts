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
import { TRANSIENT_HINT_RESET_MS } from '../../../src/settings'
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
import { fixtureAt } from '../../helpers/fixtures'

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

/** Drop an optional attribute entirely, as a payload that omits it would. */
function withoutAttributes(
  resource: Resource<SensorAttributes>,
  key: keyof SensorAttributes,
): Resource<SensorAttributes> {
  const attributes = { ...resource.attributes }
  delete attributes[key]
  return { ...resource, attributes }
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
    return fixtureAt(servicesOf(bed.accessory), 0, 'published services')
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

      accessory.update(withoutAttributes(resource, 'isMonitoringEnabled'))

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

    /**
     * `update` runs for every sensor on every poll cycle, so an unconditional
     * warning is 1,440 identical lines a day at the minimum poll interval —
     * indefinitely, since neither condition clears on its own.
     */
    describe('warning about a condition that will not clear', () => {
      it('reports an unresolvable reading once, not once per poll', () => {
        const resource = withAttributes(sensorNamed('Front Door'), { state: 1, openClosedStatus: 3 })
        const accessory = mount(resource, 'contact')

        accessory.update(resource)
        accessory.update(resource)
        accessory.update(resource)

        expect(messagesAt(log, 'warn')).toHaveLength(1)
      })

      it('reports an unsupported device type once, not once per poll', () => {
        const resource = withAttributes(sensorNamed('Front Door'), { deviceType: 6 })
        const accessory = mount(resource, 'contact')

        accessory.update(resource)
        accessory.update(resource)

        expect(messagesAt(log, 'warn')).toHaveLength(1)
      })

      it('speaks up again if the ambiguity clears and then returns', () => {
        const ambiguous = withAttributes(sensorNamed('Front Door'), { state: 1, openClosedStatus: 3 })
        const accessory = mount(ambiguous, 'contact')

        accessory.update(ambiguous)
        accessory.update(sensorNamed('Front Door'))
        accessory.update(ambiguous)

        expect(messagesAt(log, 'warn')).toHaveLength(2)
      })
    })

    it('logs the first reading at debug and later changes at info', () => {
      const closed = withAttributes(sensorNamed('Front Door'), { state: 1, openClosedStatus: 2 })
      const open = withAttributes(sensorNamed('Front Door'), { state: 2, openClosedStatus: 3 })
      const accessory = mount(closed, 'contact')

      accessory.update(closed)
      expect(messagesAt(log, 'debug')).toContain('Front Door: Closed')
      expect(messagesAt(log, 'info')).not.toContain('Front Door: Closed')

      accessory.update(open)
      expect(messagesAt(log, 'info')).toContain('Front Door: Open')

      accessory.update(open)
      expect(messagesAt(log, 'info').filter((message) => message === 'Front Door: Open')).toHaveLength(1)
    })

    it('logs motion Activated/Idle and smoke Activated/Not Reset on change', () => {
      const motion = mount(sensorNamed('Basement Motion'), 'motion')
      motion.update(sensorNamed('Basement Motion'))
      motion.update(withAttributes(sensorNamed('Basement Motion'), { state: 4, openClosedStatus: 3 }))
      expect(messagesAt(log, 'info')).toContain('Basement Motion: Activated')

      log.info.mockClear()
      const smoke = mount(sensorNamed('Upstairs Smoke'), 'smoke')
      smoke.update(sensorNamed('Upstairs Smoke'))
      smoke.update(withAttributes(sensorNamed('Upstairs Smoke'), { state: 4, openClosedStatus: 3 }))
      expect(messagesAt(log, 'info')).toContain('Upstairs Smoke: Activated')
    })

    it('logs event-hinted contact changes at info after the first reading', () => {
      const accessory = mount(sensorNamed('Front Door'), 'contact')
      accessory.update(withAttributes(sensorNamed('Front Door'), { state: 1, openClosedStatus: 2 }))

      accessory.applyImmediateState(true)

      expect(messagesAt(log, 'info')).toContain('Front Door: Open')
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

    /**
     * An open-and-close frame means the door has *already* shut. The confirming
     * read normally clears the pulse within a couple of seconds; if that read
     * fails, this timer is what stops a shut door showing open until the next
     * poll — up to a day at the maximum poll interval.
     */
    describe('a momentary pulse the confirming read never clears', () => {
      beforeEach(() => {
        jest.useFakeTimers()
      })

      afterEach(() => {
        jest.useRealTimers()
      })

      it('returns to rest on its own', () => {
        const accessory = mount(sensorNamed('Front Door'), 'contact')

        accessory.applyImmediateState(true, true)
        expect(valueOf(Characteristic.ContactSensorState))
          .toBe(Characteristic.ContactSensorState.CONTACT_NOT_DETECTED)

        jest.advanceTimersByTime(TRANSIENT_HINT_RESET_MS)

        expect(valueOf(Characteristic.ContactSensorState))
          .toBe(Characteristic.ContactSensorState.CONTACT_DETECTED)
      })

      it('defers to a real reading rather than fighting it', () => {
        const resource = withAttributes(sensorNamed('Front Door'), { state: 2, openClosedStatus: 3 })
        const accessory = mount(resource, 'contact')

        accessory.applyImmediateState(true, true)
        accessory.update(resource)
        jest.advanceTimersByTime(TRANSIENT_HINT_RESET_MS)

        expect(valueOf(Characteristic.ContactSensorState))
          .toBe(Characteristic.ContactSensorState.CONTACT_NOT_DETECTED)
      })

      it('leaves no timer behind once disposed', () => {
        const accessory = mount(sensorNamed('Front Door'), 'contact')
        accessory.applyImmediateState(true, true)
        expect(jest.getTimerCount()).toBe(1)

        accessory.dispose()

        expect(jest.getTimerCount()).toBe(0)
      })

      it('does not arm a timer for a sustained open', () => {
        const accessory = mount(sensorNamed('Front Door'), 'contact')

        accessory.applyImmediateState(true, false)

        expect(jest.getTimerCount()).toBe(0)
      })
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
