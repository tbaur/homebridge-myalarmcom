/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Sensor state resolution is the one place where a wrong answer makes HomeKit
 * show a tripped detector as safe, so every pairing verified against the live
 * account is asserted individually rather than through a table.
 */

import {
  acceptsArmingModifier,
  ArmingModifier,
  OpenClosedStatus,
  readSensorState,
  SensorDeviceType,
  SensorState,
  supportsNightArming,
  type PartitionAttributes,
} from '../../../src/types/alarm'
import partitionsFixture from '../../fixtures/partitions.json'

const livePanel = partitionsFixture.data[0].attributes as PartitionAttributes

describe('readSensorState', () => {
  describe('pairings verified on live hardware', () => {
    it('reads a contact sensor in state 1 as closed and untripped', () => {
      expect(readSensorState(SensorDeviceType.CONTACT, 1, OpenClosedStatus.CLOSED)).toEqual({
        label: 'Closed',
        isTriggered: false,
        isAmbiguous: false,
      })
    })

    it('reads a contact sensor in state 2 as open and tripped', () => {
      expect(readSensorState(SensorDeviceType.CONTACT, 2, OpenClosedStatus.OPEN)).toEqual({
        label: 'Open',
        isTriggered: true,
        isAmbiguous: false,
      })
    })

    it('reads a motion sensor in state 3 as idle and untripped', () => {
      expect(readSensorState(SensorDeviceType.MOTION, 3, OpenClosedStatus.CLOSED)).toEqual({
        label: 'Idle',
        isTriggered: false,
        isAmbiguous: false,
      })
    })

    it('reads a motion sensor in state 4 as activated and tripped', () => {
      expect(readSensorState(SensorDeviceType.MOTION, 4, OpenClosedStatus.OPEN)).toEqual({
        label: 'Activated',
        isTriggered: true,
        isAmbiguous: false,
      })
    })

    it('reads a smoke detector in state 1 as "Not Reset" without treating it as tripped', () => {
      expect(readSensorState(SensorDeviceType.SMOKE, 1, OpenClosedStatus.CLOSED)).toEqual({
        label: 'Not Reset',
        isTriggered: false,
        isAmbiguous: false,
      })
    })

    it('reads a smoke detector in state 4 as activated and tripped', () => {
      expect(readSensorState(SensorDeviceType.SMOKE, 4, OpenClosedStatus.OPEN)).toEqual({
        label: 'Activated',
        isTriggered: true,
        isAmbiguous: false,
      })
    })

    it('labels the same raw state differently per device type', () => {
      const contact = readSensorState(SensorDeviceType.CONTACT, 1, OpenClosedStatus.CLOSED)
      const smoke = readSensorState(SensorDeviceType.SMOKE, 1, OpenClosedStatus.CLOSED)

      expect(contact.label).toBe('Closed')
      expect(smoke.label).toBe('Not Reset')
      expect(contact.isTriggered).toBe(smoke.isTriggered)
    })
  })

  describe('openClosedStatus as a uniform scale', () => {
    const restingReadings = [
      [SensorDeviceType.CONTACT, SensorState.CLOSED],
      [SensorDeviceType.MOTION, SensorState.IDLE],
      [SensorDeviceType.SMOKE, SensorState.CLOSED],
    ] as const

    const trippedReadings = [
      [SensorDeviceType.CONTACT, SensorState.OPEN],
      [SensorDeviceType.MOTION, SensorState.ACTIVE],
      [SensorDeviceType.SMOKE, SensorState.ACTIVE],
    ] as const

    it.each(restingReadings)(
      'treats openClosedStatus 2 as at rest for device type %i in state %i',
      (deviceType, state) => {
        const reading = readSensorState(deviceType, state, 2)
        expect(reading.isTriggered).toBe(false)
        expect(reading.isAmbiguous).toBe(false)
      },
    )

    it.each(trippedReadings)(
      'treats openClosedStatus 3 as tripped for device type %i in state %i',
      (deviceType, state) => {
        const reading = readSensorState(deviceType, state, 3)
        expect(reading.isTriggered).toBe(true)
        expect(reading.isAmbiguous).toBe(false)
      },
    )
  })

  describe('states this plugin has never seen', () => {
    it('falls back to openClosedStatus and flags the reading as ambiguous', () => {
      expect(readSensorState(SensorDeviceType.CONTACT, 42, OpenClosedStatus.OPEN)).toEqual({
        label: 'Unknown',
        isTriggered: true,
        isAmbiguous: true,
      })
    })

    it('reports a tripped smoke detector rather than a safe one when the state is unfamiliar', () => {
      expect(readSensorState(SensorDeviceType.SMOKE, 42, OpenClosedStatus.OPEN).isTriggered).toBe(true)
    })

    it('reports at rest when the unfamiliar state comes with a resting openClosedStatus', () => {
      expect(readSensorState(SensorDeviceType.MOTION, 42, OpenClosedStatus.CLOSED)).toEqual({
        label: 'Unknown',
        isTriggered: false,
        isAmbiguous: true,
      })
    })

    it('names a state the enum knows but no device type labels', () => {
      expect(readSensorState(SensorDeviceType.CONTACT, SensorState.UNKNOWN, OpenClosedStatus.CLOSED).label)
        .toBe('UNKNOWN')
    })

    it('is ambiguous when neither the state nor openClosedStatus is usable', () => {
      expect(readSensorState(SensorDeviceType.CONTACT, 42, OpenClosedStatus.UNKNOWN)).toEqual({
        label: 'Unknown',
        isTriggered: false,
        isAmbiguous: true,
      })
    })

    it('is ambiguous when the state is unfamiliar and openClosedStatus is absent', () => {
      expect(readSensorState(SensorDeviceType.CONTACT, 42).isAmbiguous).toBe(true)
    })
  })

  describe('when state and openClosedStatus disagree', () => {
    it('keeps the state reading but flags the disagreement', () => {
      expect(readSensorState(SensorDeviceType.CONTACT, SensorState.CLOSED, OpenClosedStatus.OPEN)).toEqual({
        label: 'Closed',
        isTriggered: false,
        isAmbiguous: true,
      })
    })

    it('still trusts the state when it reports tripped and openClosedStatus does not', () => {
      expect(readSensorState(SensorDeviceType.CONTACT, SensorState.OPEN, OpenClosedStatus.CLOSED)).toEqual({
        label: 'Open',
        isTriggered: true,
        isAmbiguous: true,
      })
    })
  })

  describe('when openClosedStatus is unavailable', () => {
    it('trusts a recognised state without flagging ambiguity', () => {
      expect(readSensorState(SensorDeviceType.MOTION, SensorState.ACTIVE)).toEqual({
        label: 'Activated',
        isTriggered: true,
        isAmbiguous: false,
      })
    })

    it('treats openClosedStatus 0 the same as an absent one', () => {
      expect(readSensorState(SensorDeviceType.MOTION, SensorState.IDLE, OpenClosedStatus.UNKNOWN)).toEqual(
        readSensorState(SensorDeviceType.MOTION, SensorState.IDLE),
      )
    })

    it('classifies the inferred wet and dry states', () => {
      expect(readSensorState(SensorDeviceType.CONTACT, SensorState.WET).isTriggered).toBe(true)
      expect(readSensorState(SensorDeviceType.CONTACT, SensorState.DRY).isTriggered).toBe(false)
    })
  })
})

describe('supportsNightArming', () => {
  it('is false for the live panel, which advertises no ArmedNight options', () => {
    expect(supportsNightArming(livePanel)).toBe(false)
  })

  it('is not swayed by supportsNightArmingSchedules being true', () => {
    expect(livePanel.supportsNightArmingSchedules).toBe(true)
    expect(supportsNightArming(livePanel)).toBe(false)
  })

  it('is true as soon as an ArmedNight entry exists, even with no modifiers listed', () => {
    const attributes: PartitionAttributes = {
      ...livePanel,
      extendedArmingOptions: { ...livePanel.extendedArmingOptions, ArmedNight: [] },
    }

    expect(supportsNightArming(attributes)).toBe(true)
  })

  it('is false when the panel reports no extended arming options at all', () => {
    const attributes: PartitionAttributes = { ...livePanel, extendedArmingOptions: undefined }

    expect(supportsNightArming(attributes)).toBe(false)
  })
})

describe('acceptsArmingModifier', () => {
  it('accepts the modifiers the live panel advertises for stay arming', () => {
    expect(acceptsArmingModifier(livePanel, 'ArmedStay', ArmingModifier.NO_ENTRY_DELAY)).toBe(true)
    expect(acceptsArmingModifier(livePanel, 'ArmedStay', ArmingModifier.BYPASS_SENSORS)).toBe(true)
    expect(acceptsArmingModifier(livePanel, 'ArmedStay', ArmingModifier.SELECTIVELY_BYPASS_SENSORS)).toBe(true)
  })

  it('rejects silent arming, which the live panel never advertised', () => {
    expect(acceptsArmingModifier(livePanel, 'ArmedStay', ArmingModifier.SILENT_ARMING)).toBe(false)
    expect(acceptsArmingModifier(livePanel, 'ArmedAway', ArmingModifier.SILENT_ARMING)).toBe(false)
  })

  it('distinguishes modifiers per arming mode', () => {
    expect(acceptsArmingModifier(livePanel, 'ArmedAway', ArmingModifier.NO_ENTRY_DELAY)).toBe(false)
    expect(acceptsArmingModifier(livePanel, 'ArmedAway', ArmingModifier.BYPASS_SENSORS)).toBe(true)
  })

  it('rejects every modifier for a mode the panel does not offer', () => {
    expect(acceptsArmingModifier(livePanel, 'ArmedNight', ArmingModifier.NIGHT_ARMING)).toBe(false)
    expect(acceptsArmingModifier(livePanel, 'Disarmed', ArmingModifier.BYPASS_SENSORS)).toBe(false)
  })

  it('rejects every modifier when the panel reports no extended arming options', () => {
    const attributes: PartitionAttributes = { ...livePanel, extendedArmingOptions: undefined }

    expect(acceptsArmingModifier(attributes, 'ArmedStay', ArmingModifier.FORCE_ARM)).toBe(false)
  })
})
