/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Arming requests are driven through HAP's own write path, so the HAP status
 * codes the Home app would see are what these tests assert on.
 */

import { Characteristic, Service } from '@homebridge/hap-nodejs'
import { HAPStatus } from 'homebridge'
import { PartitionAccessory, type PartitionAccessoryContext } from '../../../src/devices/partition'
import type { PartitionAttributes, Resource } from '../../../src/types/alarm'
import { HomeKitSecurityState, HomeKitSecurityTarget } from '../../../src/utils/mappers'
import {
  characteristicValue,
  createPlatformTestBed,
  servicesOf,
  type PlatformTestBed,
} from '../../helpers/homekit'
import { createRecordingLogger, messagesAt, type RecordingLogger } from '../../helpers/logger'
import partitionsFixture from '../../fixtures/partitions.json'
import { fixtureAt } from '../../helpers/fixtures'
import { PARTITION_TARGET_SETTLE_MS } from '../../../src/settings'

const livePartition = partitionsFixture.data[0] as unknown as Resource<PartitionAttributes>

function withAttributes(overrides: Partial<PartitionAttributes>): Resource<PartitionAttributes> {
  return { ...livePartition, attributes: { ...livePartition.attributes, ...overrides } }
}

/** A panel the account may control, unlike the read-only one in the fixture. */
const controllable = withAttributes({ hasPermissionToChangeState: true })

describe('PartitionAccessory', () => {
  let log: RecordingLogger
  let bed: PlatformTestBed
  let accessory: PartitionAccessory

  function mount(): PartitionAccessory {
    const context: PartitionAccessoryContext = {
      deviceId: livePartition.id,
      kind: 'partition',
      displayName: 'Home',
    }
    bed = createPlatformTestBed(context as unknown as Record<string, unknown>)
    accessory = new PartitionAccessory(bed.platform, bed.accessory, log)
    return accessory
  }

  function service(): Service {
    return fixtureAt(servicesOf(bed.accessory), 0, 'published services')
  }

  function targetCharacteristic(): Characteristic {
    return service().getCharacteristic(Characteristic.SecuritySystemTargetState)
  }

  /** Write a target state the way HAP does when the Home app asks. */
  async function requestTarget(value: number): Promise<unknown> {
    return targetCharacteristic().handleSetRequest(value)
  }

  beforeEach(() => {
    log = createRecordingLogger()
    mount()
    bed.commandPartition.mockResolvedValue(livePartition)
  })

  describe('publishing the service', () => {
    it('publishes a security system named after the partition', () => {
      expect(service().UUID).toBe(Service.SecuritySystem.UUID)
      expect(characteristicValue(service(), Characteristic.Name)).toBe('Home')
    })

    it('answers a state read from the last known attributes', async () => {
      accessory.update(withAttributes({ state: 3 }))

      const current = service().getCharacteristic(Characteristic.SecuritySystemCurrentState)

      await expect(current.handleGetRequest()).resolves.toBe(HomeKitSecurityState.AWAY_ARM)
    })

    it('answers disarmed before Alarm.com has reported anything', async () => {
      const current = service().getCharacteristic(Characteristic.SecuritySystemCurrentState)

      await expect(current.handleGetRequest()).resolves.toBe(HomeKitSecurityState.DISARMED)
    })

    it('exposes the device id it was configured with', () => {
      expect(accessory.deviceId).toBe('1234567-127')
    })
  })

  describe('update', () => {
    it('pushes the arming state into HomeKit', () => {
      accessory.update(withAttributes({ state: 2 }))

      expect(characteristicValue(service(), Characteristic.SecuritySystemCurrentState))
        .toBe(HomeKitSecurityState.STAY_ARM)
    })

    it('shows a triggered alarm even while the panel still reports armed away', () => {
      accessory.update(withAttributes({ state: 3, hasActiveAlarm: true }))

      expect(characteristicValue(service(), Characteristic.SecuritySystemCurrentState))
        .toBe(HomeKitSecurityState.ALARM_TRIGGERED)
      expect(messagesAt(log, 'warn').join('\n')).toMatch(/active alarm on "Home"/)
    })

    /**
     * `ALARM_TRIGGERED` is 4, which is a legal *current* state and an illegal
     * *target*: HAP caps the target at 3 and silently rewrote 4 to 3. So during an
     * alarm the Home app tile read "Triggered" while its own control read
     * "Disarm", and HAP emitted a characteristic warning on every poll for the
     * duration of the alarm. The panel is still armed in whatever mode it was, so
     * that is what the target has to keep showing.
     */
    it('keeps showing the armed target during an alarm rather than an out-of-range value', () => {
      accessory.update(withAttributes({ state: 3 }))
      expect(characteristicValue(service(), Characteristic.SecuritySystemTargetState))
        .toBe(HomeKitSecurityTarget.AWAY_ARM)

      accessory.update(withAttributes({ state: 3, hasActiveAlarm: true }))

      expect(characteristicValue(service(), Characteristic.SecuritySystemCurrentState))
        .toBe(HomeKitSecurityState.ALARM_TRIGGERED)
      expect(characteristicValue(service(), Characteristic.SecuritySystemTargetState))
        .toBe(HomeKitSecurityTarget.AWAY_ARM)
    })

    /** The alarm-cleared edge must survive a reading the plugin cannot map. */
    it('reports an alarm clearing even when the next state is unrecognised', () => {
      accessory.update(withAttributes({ state: 3, hasActiveAlarm: true }))

      accessory.update(withAttributes({ state: 99, hasActiveAlarm: false }))

      expect(messagesAt(log, 'info').join('\n')).toMatch(/alarm on "Home" has cleared/)
    })

    it('logs arming changes at info after the first reading', () => {
      accessory.update(withAttributes({ state: 1 }))
      expect(messagesAt(log, 'debug')).toContain('Home: Disarmed')

      accessory.update(withAttributes({ state: 3 }))
      expect(messagesAt(log, 'info')).toContain('Home: Armed Away')
    })

    /**
     * The one failure a security integration must not have. A green,
     * safe-looking tile for a panel whose real state is unknown is
     * indistinguishable from a genuinely disarmed system, so the last known
     * state stands and the tile is visibly faulted instead.
     */
    it('keeps the last known state and raises a fault on an unknown panel state', () => {
      accessory.update(withAttributes({ state: 3 }))

      accessory.update(withAttributes({ state: 99 }))

      expect(characteristicValue(service(), Characteristic.SecuritySystemCurrentState))
        .toBe(HomeKitSecurityState.AWAY_ARM)
      expect(characteristicValue(service(), Characteristic.StatusFault))
        .toBe(Characteristic.StatusFault.GENERAL_FAULT)
      expect(messagesAt(log, 'warn').join('\n')).toMatch(/does not recognise \(99\)/)
    })

    it('still answers disarmed before any reading, because HAP needs a value', async () => {
      const current = service().getCharacteristic(Characteristic.SecuritySystemCurrentState)

      await expect(current.handleGetRequest()).resolves.toBe(HomeKitSecurityState.DISARMED)
    })

    it('raises a fault for a malfunctioning panel', () => {
      accessory.update(withAttributes({ isMalfunctioning: true }))

      expect(characteristicValue(service(), Characteristic.StatusFault))
        .toBe(Characteristic.StatusFault.GENERAL_FAULT)
    })

    it('offers only the modes the panel supports', () => {
      accessory.update(livePartition)

      expect(targetCharacteristic().props.validValues).toEqual([
        HomeKitSecurityTarget.STAY_ARM,
        HomeKitSecurityTarget.AWAY_ARM,
        HomeKitSecurityTarget.DISARM,
      ])
    })

    it('offers night arming to a panel that advertises it', () => {
      accessory.update(withAttributes({
        extendedArmingOptions: { ArmedStay: [1, 0, 4], ArmedAway: [0, 4], ArmedNight: [0] },
      }))

      expect(targetCharacteristic().props.validValues).toContain(HomeKitSecurityTarget.NIGHT_ARM)
    })

    it('makes a panel the account cannot control read-only, and says why once', () => {
      accessory.update(livePartition)
      accessory.update(livePartition)

      expect(targetCharacteristic().props.perms).toEqual(['pr', 'ev'])
      expect(messagesAt(log, 'warn')).toEqual([
        'The Alarm.com account used cannot change the arming state of "Home".',
      ])
    })

    it('leaves a controllable panel writable', () => {
      accessory.update(controllable)

      expect(targetCharacteristic().props.perms).toContain('pw')
      expect(log.warn).not.toHaveBeenCalled()
    })

    /**
     * The tile must agree with the guard on the write path. That guard refuses
     * anything but a literal `true`, so presenting controls for anything less
     * would offer buttons that reject every press.
     */
    it.each([
      ['the field is missing', {}],
      ['the field is null', { hasPermissionToChangeState: null }],
      ['the field is a string', { hasPermissionToChangeState: 'true' }],
    ])('is read-only when %s', (_label, overrides) => {
      accessory.update(withAttributes(overrides as Partial<PartitionAttributes>))

      expect(targetCharacteristic().props.perms).not.toContain('pw')
    })

    it('holds the requested target until the panel confirms it', async () => {
      accessory.update(controllable)
      await requestTarget(HomeKitSecurityTarget.AWAY_ARM)

      accessory.update({ ...controllable, attributes: { ...controllable.attributes, state: 1 } })
      expect(characteristicValue(service(), Characteristic.SecuritySystemTargetState))
        .toBe(HomeKitSecurityTarget.AWAY_ARM)

      accessory.update({ ...controllable, attributes: { ...controllable.attributes, state: 3 } })
      expect(characteristicValue(service(), Characteristic.SecuritySystemTargetState))
        .toBe(HomeKitSecurityTarget.AWAY_ARM)
      expect(characteristicValue(service(), Characteristic.SecuritySystemCurrentState))
        .toBe(HomeKitSecurityState.AWAY_ARM)
    })

    /**
     * Confirmation is not guaranteed. Night arming is sent as a stay command, so
     * the panel lands on a state that never equals the requested target, and a
     * user can abort an arm at the keypad. Either left the Home app showing
     * "Arming…" for the life of the process.
     */
    it('gives up on a target the panel never reaches', async () => {
      jest.useFakeTimers()
      try {
        accessory.update(controllable)
        await requestTarget(HomeKitSecurityTarget.AWAY_ARM)

        jest.advanceTimersByTime(PARTITION_TARGET_SETTLE_MS)
        accessory.update({ ...controllable, attributes: { ...controllable.attributes, state: 1 } })

        expect(characteristicValue(service(), Characteristic.SecuritySystemTargetState))
          .toBe(HomeKitSecurityTarget.DISARM)
        expect(messagesAt(log, 'info').join('\n')).toMatch(/did not reach Armed Away/)
      } finally {
        jest.useRealTimers()
      }
    })

    /**
     * Computing these only once meant a panel that later gained night arming,
     * or an account that was granted permission to arm, kept the first
     * reading's properties until Homebridge restarted.
     */
    it('re-offers the modes when the panel starts advertising a new one', () => {
      accessory.update(controllable)
      expect(targetCharacteristic().props.validValues)
        .not.toContain(HomeKitSecurityTarget.NIGHT_ARM)

      accessory.update({
        ...controllable,
        attributes: {
          ...controllable.attributes,
          extendedArmingOptions: { ArmedStay: [0], ArmedNight: [0] },
        },
      })

      expect(targetCharacteristic().props.validValues).toContain(HomeKitSecurityTarget.NIGHT_ARM)
    })

    it('makes the tile writable when the account is granted permission', () => {
      accessory.update(livePartition)
      expect(targetCharacteristic().props.perms).not.toContain('pw')

      accessory.update(controllable)

      expect(targetCharacteristic().props.perms).toContain('pw')
    })

    /**
     * A siren that starts is reported; one that stops used to be reported
     * nowhere, so a log could show when an alarm began but never when it ended.
     */
    it('warns once on the edge into alarm and says plainly when it clears', () => {
      const inAlarm = withAttributes({ hasActiveAlarm: true })

      accessory.update(inAlarm)
      accessory.update(inAlarm)
      expect(messagesAt(log, 'warn').filter((line) => line.includes('active alarm'))).toHaveLength(1)

      accessory.update(withAttributes({ hasActiveAlarm: false }))

      expect(messagesAt(log, 'info').join('\n')).toMatch(/alarm on "Home" has cleared/)
    })
  })

  describe('arming from HomeKit', () => {
    beforeEach(() => {
      accessory.update(controllable)
    })

    it('sends the matching command verb', async () => {
      await requestTarget(HomeKitSecurityTarget.AWAY_ARM)

      expect(bed.commandPartition).toHaveBeenCalledWith('1234567-127', 'armAway', expect.any(Object))
      expect(bed.recordCommand).toHaveBeenCalledTimes(1)
      expect(messagesAt(log, 'info').some((message) => /^Home: Armed Away \(Latency: \d+ms\)$/.test(message)))
        .toBe(true)
    })

    it('disarms', async () => {
      await requestTarget(HomeKitSecurityTarget.DISARM)

      expect(bed.commandPartition).toHaveBeenCalledWith('1234567-127', 'disarm', expect.any(Object))
      expect(messagesAt(log, 'info').some((message) => /^Home: Disarmed \(Latency: \d+ms\)$/.test(message)))
        .toBe(true)
    })

    it('sends night arming as a stay command carrying the modifier', async () => {
      await requestTarget(HomeKitSecurityTarget.NIGHT_ARM)

      expect(bed.commandPartition).toHaveBeenCalledWith(
        '1234567-127',
        'armStay',
        expect.objectContaining({ nightArming: true }),
      )
    })

    it('does not set the night modifier on an ordinary stay command', async () => {
      await requestTarget(HomeKitSecurityTarget.STAY_ARM)

      expect(bed.commandPartition).toHaveBeenCalledWith(
        '1234567-127',
        'armStay',
        expect.objectContaining({ nightArming: false }),
      )
    })

    it('asks to bypass open sensors only when the panel allows it and some are open', async () => {
      accessory.update(withAttributes({
        hasPermissionToChangeState: true,
        hasOpenBypassableSensors: true,
        extendedArmingOptions: { ArmedStay: [5], ArmedAway: [] },
      }))

      await requestTarget(HomeKitSecurityTarget.STAY_ARM)

      expect(bed.commandPartition).toHaveBeenCalledWith(
        '1234567-127',
        'armStay',
        expect.objectContaining({ forceBypass: true }),
      )
    })

    it('does not ask to bypass when the panel does not advertise force arming', async () => {
      accessory.update(withAttributes({
        hasPermissionToChangeState: true,
        hasOpenBypassableSensors: true,
      }))

      await requestTarget(HomeKitSecurityTarget.STAY_ARM)

      expect(bed.commandPartition).toHaveBeenCalledWith(
        '1234567-127',
        'armStay',
        expect.objectContaining({ forceBypass: false }),
      )
    })

    it('does not ask to bypass when nothing is open', async () => {
      accessory.update(withAttributes({
        hasPermissionToChangeState: true,
        hasOpenBypassableSensors: false,
        extendedArmingOptions: { ArmedStay: [5] },
      }))

      await requestTarget(HomeKitSecurityTarget.STAY_ARM)

      expect(bed.commandPartition).toHaveBeenCalledWith(
        '1234567-127',
        'armStay',
        expect.objectContaining({ forceBypass: false }),
      )
    })

    /**
     * Regression. Force arming was read off `ArmedStay` whatever mode was
     * requested, so a panel offering it only for away arming never received
     * the flag and away arming failed with open sensors that the Alarm.com app
     * would have bypassed.
     */
    describe('force arming is read from the mode actually being requested', () => {
      it('asks to bypass for away arming when only ArmedAway allows it', async () => {
        accessory.update(withAttributes({
          hasPermissionToChangeState: true,
          hasOpenBypassableSensors: true,
          extendedArmingOptions: { ArmedStay: [], ArmedAway: [5] },
        }))

        await requestTarget(HomeKitSecurityTarget.AWAY_ARM)

        expect(bed.commandPartition).toHaveBeenCalledWith(
          '1234567-127',
          'armAway',
          expect.objectContaining({ forceBypass: true }),
        )
      })

      it('does not ask to bypass for away arming when only ArmedStay allows it', async () => {
        accessory.update(withAttributes({
          hasPermissionToChangeState: true,
          hasOpenBypassableSensors: true,
          extendedArmingOptions: { ArmedStay: [5], ArmedAway: [] },
        }))

        await requestTarget(HomeKitSecurityTarget.AWAY_ARM)

        expect(bed.commandPartition).toHaveBeenCalledWith(
          '1234567-127',
          'armAway',
          expect.objectContaining({ forceBypass: false }),
        )
      })

      it('reads night arming from ArmedNight, not from the armStay verb it is sent as', async () => {
        accessory.update(withAttributes({
          hasPermissionToChangeState: true,
          hasOpenBypassableSensors: true,
          extendedArmingOptions: { ArmedStay: [], ArmedNight: [5, 0] },
        }))

        await requestTarget(HomeKitSecurityTarget.NIGHT_ARM)

        expect(bed.commandPartition).toHaveBeenCalledWith(
          '1234567-127',
          'armStay',
          expect.objectContaining({ nightArming: true, forceBypass: true }),
        )
      })
    })

    it('asks for a confirming read rather than trusting the command', async () => {
      await requestTarget(HomeKitSecurityTarget.AWAY_ARM)

      expect(bed.requestDeviceRefresh).toHaveBeenCalledWith('1234567-127')
    })
  })

  describe('when the command cannot be sent', () => {
    it('refuses a write on a panel the account may not control', async () => {
      accessory.update(livePartition)

      await expect(requestTarget(HomeKitSecurityTarget.AWAY_ARM))
        .rejects.toBe(HAPStatus.INSUFFICIENT_PRIVILEGES)
      expect(bed.commandPartition).not.toHaveBeenCalled()
      expect(messagesAt(log, 'error').join('\n')).toMatch(/account used cannot change the arming state/)
    })

    it('rejects a target state that maps to no command', async () => {
      accessory.update(controllable)

      await expect(requestTarget(42)).rejects.toBe(HAPStatus.INVALID_VALUE_IN_REQUEST)
      expect(bed.commandPartition).not.toHaveBeenCalled()
    })

    it('reports a communication failure and forgets the pending target', async () => {
      accessory.update(controllable)
      bed.commandPartition.mockRejectedValue(new Error('Alarm.com returned 500'))

      await expect(requestTarget(HomeKitSecurityTarget.AWAY_ARM))
        .rejects.toBe(HAPStatus.SERVICE_COMMUNICATION_FAILURE)

      accessory.update(controllable)
      expect(characteristicValue(service(), Characteristic.SecuritySystemTargetState))
        .toBe(HomeKitSecurityTarget.DISARM)
      expect(messagesAt(log, 'error').join('\n')).toMatch(/Failed to armAway partition 1234567-127/)
    })

    /**
     * Fails closed. Permission is unknown until a reading arrives, and the
     * safe answer to "may this account disarm the alarm?" when nobody knows is
     * no. This previously sent the command, because the guard tested for a
     * literal `false` that an unread partition never produces.
     */
    it('refuses the command when no state has been read yet', async () => {
      await expect(requestTarget(HomeKitSecurityTarget.DISARM))
        .rejects.toBe(HAPStatus.INSUFFICIENT_PRIVILEGES)

      expect(bed.commandPartition).not.toHaveBeenCalled()
    })

    it.each([
      ['the field is missing', {}],
      ['the field is null', { hasPermissionToChangeState: null }],
      ['the field is a string', { hasPermissionToChangeState: 'false' }],
      ['the field is zero', { hasPermissionToChangeState: 0 }],
    ])('refuses the command when %s', async (_label, overrides) => {
      // Responses are parsed with no runtime validation, so any of these can
      // arrive from a panel or an API change. Only a literal `true` may pass.
      accessory.update(withAttributes(overrides as Partial<PartitionAttributes>))

      await expect(requestTarget(HomeKitSecurityTarget.DISARM))
        .rejects.toBe(HAPStatus.INSUFFICIENT_PRIVILEGES)

      expect(bed.commandPartition).not.toHaveBeenCalled()
    })
  })
})
