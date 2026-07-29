/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * The mappers deliberately mirror HAP's numeric constants instead of importing
 * them, so the module can be tested without a Homebridge environment. That
 * decoupling is only safe while the copies still match, which is what the
 * first suite here guards. hap-nodejs arrives with the homebridge dev
 * dependency under its scoped name.
 */

import { Characteristic } from '@homebridge/hap-nodejs'
import {
  HomeKitContactState,
  HomeKitSecurityState,
  HomeKitSecurityTarget,
  HomeKitSmokeState,
  toDisplayedSecurityState,
  toHomeKitSecurityState,
  toHomeKitSensorState,
  toPartitionAction,
  toPartitionState,
  toSensorServiceKind,
} from '../../../src/utils/mappers'
import {
  PartitionState,
  type PartitionAttributes,
  type Resource,
  type SensorAttributes,
} from '../../../src/types/alarm'
import partitionsFixture from '../../fixtures/partitions.json'
import sensorsFixture from '../../fixtures/sensors.json'

const sensors = sensorsFixture.data as unknown as Resource<SensorAttributes>[]
const livePanel = partitionsFixture.data[0].attributes as PartitionAttributes

function sensorNamed(description: string): SensorAttributes {
  const match = sensors.find((sensor) => sensor.attributes.description === description)
  if (!match) {
    throw new Error(`No sensor named "${description}" in the fixture`)
  }
  return match.attributes
}

describe('local HomeKit enums', () => {
  it('matches the real SecuritySystemCurrentState values', () => {
    expect(HomeKitSecurityState.STAY_ARM).toBe(Characteristic.SecuritySystemCurrentState.STAY_ARM)
    expect(HomeKitSecurityState.AWAY_ARM).toBe(Characteristic.SecuritySystemCurrentState.AWAY_ARM)
    expect(HomeKitSecurityState.NIGHT_ARM).toBe(Characteristic.SecuritySystemCurrentState.NIGHT_ARM)
    expect(HomeKitSecurityState.DISARMED).toBe(Characteristic.SecuritySystemCurrentState.DISARMED)
    expect(HomeKitSecurityState.ALARM_TRIGGERED)
      .toBe(Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED)
  })

  it('matches the real SecuritySystemTargetState values', () => {
    expect(HomeKitSecurityTarget.STAY_ARM).toBe(Characteristic.SecuritySystemTargetState.STAY_ARM)
    expect(HomeKitSecurityTarget.AWAY_ARM).toBe(Characteristic.SecuritySystemTargetState.AWAY_ARM)
    expect(HomeKitSecurityTarget.NIGHT_ARM).toBe(Characteristic.SecuritySystemTargetState.NIGHT_ARM)
    expect(HomeKitSecurityTarget.DISARM).toBe(Characteristic.SecuritySystemTargetState.DISARM)
  })

  it('matches the real ContactSensorState values', () => {
    expect(HomeKitContactState.CONTACT_DETECTED).toBe(Characteristic.ContactSensorState.CONTACT_DETECTED)
    expect(HomeKitContactState.CONTACT_NOT_DETECTED)
      .toBe(Characteristic.ContactSensorState.CONTACT_NOT_DETECTED)
  })

  it('matches the real SmokeDetected values', () => {
    expect(HomeKitSmokeState.SMOKE_NOT_DETECTED).toBe(Characteristic.SmokeDetected.SMOKE_NOT_DETECTED)
    expect(HomeKitSmokeState.SMOKE_DETECTED).toBe(Characteristic.SmokeDetected.SMOKE_DETECTED)
  })
})

describe('toHomeKitSecurityState', () => {
  it('maps each arming state Alarm.com reports', () => {
    expect(toHomeKitSecurityState(PartitionState.DISARMED)).toBe(HomeKitSecurityState.DISARMED)
    expect(toHomeKitSecurityState(PartitionState.ARMED_STAY)).toBe(HomeKitSecurityState.STAY_ARM)
    expect(toHomeKitSecurityState(PartitionState.ARMED_AWAY)).toBe(HomeKitSecurityState.AWAY_ARM)
    expect(toHomeKitSecurityState(PartitionState.ARMED_NIGHT)).toBe(HomeKitSecurityState.NIGHT_ARM)
  })

  it('returns undefined rather than disarmed for an unrecognised state', () => {
    expect(toHomeKitSecurityState(PartitionState.UNKNOWN)).toBeUndefined()
    expect(toHomeKitSecurityState(99)).toBeUndefined()
  })
})

describe('toPartitionState', () => {
  it('maps each HomeKit target back to the Alarm.com state it requests', () => {
    expect(toPartitionState(HomeKitSecurityTarget.STAY_ARM)).toBe(PartitionState.ARMED_STAY)
    expect(toPartitionState(HomeKitSecurityTarget.AWAY_ARM)).toBe(PartitionState.ARMED_AWAY)
    expect(toPartitionState(HomeKitSecurityTarget.NIGHT_ARM)).toBe(PartitionState.ARMED_NIGHT)
    expect(toPartitionState(HomeKitSecurityTarget.DISARM)).toBe(PartitionState.DISARMED)
  })

  it('returns undefined for a target HomeKit should never send', () => {
    expect(toPartitionState(7)).toBeUndefined()
  })
})

describe('toPartitionAction', () => {
  it('maps stay, away, and disarm to their command verbs', () => {
    expect(toPartitionAction(HomeKitSecurityTarget.STAY_ARM)).toBe('armStay')
    expect(toPartitionAction(HomeKitSecurityTarget.AWAY_ARM)).toBe('armAway')
    expect(toPartitionAction(HomeKitSecurityTarget.DISARM)).toBe('disarm')
  })

  it('maps night arming onto the stay verb, since it is a modifier rather than a command', () => {
    expect(toPartitionAction(HomeKitSecurityTarget.NIGHT_ARM)).toBe('armStay')
  })

  it('returns undefined for an unknown target', () => {
    expect(toPartitionAction(42)).toBeUndefined()
  })
})

describe('toDisplayedSecurityState', () => {
  it('reports a triggered alarm even though the panel still names an arming mode', () => {
    const attributes: PartitionAttributes = {
      ...livePanel,
      state: PartitionState.ARMED_AWAY,
      hasActiveAlarm: true,
    }

    expect(toHomeKitSecurityState(attributes.state)).toBe(HomeKitSecurityState.AWAY_ARM)
    expect(toDisplayedSecurityState(attributes)).toBe(HomeKitSecurityState.ALARM_TRIGGERED)
  })

  it('reports the arming mode when no alarm is active', () => {
    expect(toDisplayedSecurityState(livePanel)).toBe(HomeKitSecurityState.DISARMED)
  })

  it('returns undefined for an unrecognised state instead of defaulting to disarmed', () => {
    const attributes: PartitionAttributes = { ...livePanel, state: 99 }

    expect(toDisplayedSecurityState(attributes)).toBeUndefined()
  })
})

describe('toSensorServiceKind', () => {
  it('maps the supported device types', () => {
    expect(toSensorServiceKind(1)).toBe('contact')
    expect(toSensorServiceKind(2)).toBe('motion')
    expect(toSensorServiceKind(5)).toBe('smoke')
  })

  it('returns undefined for a device type the plugin does not handle', () => {
    expect(toSensorServiceKind(6)).toBeUndefined()
  })
})

describe('toHomeKitSensorState', () => {
  it('maps a closed contact sensor to contact detected', () => {
    expect(toHomeKitSensorState(sensorNamed('Front Door'))).toEqual({
      kind: 'contact',
      value: HomeKitContactState.CONTACT_DETECTED,
      label: 'Closed',
      isAmbiguous: false,
    })
  })

  it('maps an open contact sensor to contact not detected', () => {
    expect(toHomeKitSensorState(sensorNamed('Kitchen Window'))).toEqual({
      kind: 'contact',
      value: HomeKitContactState.CONTACT_NOT_DETECTED,
      label: 'Open',
      isAmbiguous: false,
    })
  })

  it('maps an activated motion sensor to a boolean true', () => {
    expect(toHomeKitSensorState(sensorNamed('Hallway Motion'))).toEqual({
      kind: 'motion',
      value: true,
      label: 'Activated',
      isAmbiguous: false,
    })
  })

  it('maps an idle motion sensor to a boolean false', () => {
    expect(toHomeKitSensorState(sensorNamed('Basement Motion'))).toEqual({
      kind: 'motion',
      value: false,
      label: 'Idle',
      isAmbiguous: false,
    })
  })

  it('maps a smoke detector at rest to smoke not detected', () => {
    expect(toHomeKitSensorState(sensorNamed('Upstairs Smoke'))).toEqual({
      kind: 'smoke',
      value: HomeKitSmokeState.SMOKE_NOT_DETECTED,
      label: 'Not Reset',
      isAmbiguous: false,
    })
  })

  it('maps a tripped smoke detector to smoke detected', () => {
    const attributes: SensorAttributes = { ...sensorNamed('Upstairs Smoke'), state: 4, openClosedStatus: 3 }

    expect(toHomeKitSensorState(attributes)).toMatchObject({
      kind: 'smoke',
      value: HomeKitSmokeState.SMOKE_DETECTED,
    })
  })

  it('returns undefined for an unsupported device type', () => {
    expect(toHomeKitSensorState(sensorNamed('Glass Break'))).toBeUndefined()
  })

  it('passes ambiguity through so the caller can warn about it', () => {
    const attributes: SensorAttributes = { ...sensorNamed('Front Door'), state: 1, openClosedStatus: 3 }

    expect(toHomeKitSensorState(attributes)).toMatchObject({
      value: HomeKitContactState.CONTACT_DETECTED,
      isAmbiguous: true,
    })
  })

  it('agrees with what Alarm.com itself displays for every fixture sensor', () => {
    const supported = sensors.filter((sensor) => toSensorServiceKind(sensor.attributes.deviceType))

    for (const sensor of supported) {
      expect(toHomeKitSensorState(sensor.attributes)?.label).toBe(sensor.attributes.displayStateText)
    }
    expect(supported).toHaveLength(5)
  })
})
