import {
  ContactEventType,
  EVENT_TYPE_USER_LOGGED_IN,
  readSensorEventHint,
  type AlarmComEvent,
} from '../../../src/types/events'
import { SensorDeviceType } from '../../../src/types/alarm'

function frame(overrides: Partial<AlarmComEvent> = {}): AlarmComEvent {
  return {
    EventDateUtc: '2026-01-14T08:30:00Z',
    UnitId: 1234567,
    DeviceId: 1,
    EventType: ContactEventType.OPENED,
    EventValue: 0,
    CorrelatedId: null,
    QstringForExtraData: null,
    DeviceType: SensorDeviceType.CONTACT,
    ...overrides,
  }
}

describe('reading an immediate state hint from an event', () => {
  it('treats an open event as triggered and expects it to persist', () => {
    expect(readSensorEventHint(frame({ EventType: ContactEventType.OPENED }), 'contact')).toEqual({
      isTriggered: true,
      isTransient: false,
    })
  })

  it('treats a close event as back at rest', () => {
    expect(readSensorEventHint(frame({ EventType: ContactEventType.CLOSED }), 'contact')).toEqual({
      isTriggered: false,
      isTransient: false,
    })
  })

  /**
   * The pulse is the entire reason this decoding exists: the door is already
   * shut by the time the confirming read lands, so HomeKit would otherwise
   * never see it open.
   */
  it('reports an open-and-close as a momentary trigger', () => {
    expect(readSensorEventHint(frame({ EventType: ContactEventType.OPENED_AND_CLOSED }), 'contact')).toEqual({
      isTriggered: true,
      isTransient: true,
    })
  })

  it('declines to guess for event types it does not know', () => {
    expect(readSensorEventHint(frame({ EventType: 999 }), 'contact')).toBeUndefined()
  })

  it('ignores a sign-in event, which carries no device state', () => {
    expect(readSensorEventHint(frame({ EventType: EVENT_TYPE_USER_LOGGED_IN }), 'contact')).toBeUndefined()
  })

  /**
   * The numeric codes are only known to mean open/closed on contacts, so the
   * same value arriving from another kind of device must not be decoded.
   */
  it.each([
    ['motion', 'motion'],
    ['smoke', 'smoke'],
  ] as const)('declines to decode a contact code for a %s sensor', (_label, kind) => {
    const hint = readSensorEventHint(frame({ EventType: ContactEventType.OPENED }), kind)

    expect(hint).toBeUndefined()
  })

  it('declines to decode for a device it has no type for', () => {
    expect(readSensorEventHint(frame({ EventType: ContactEventType.OPENED }), undefined)).toBeUndefined()
  })

  /**
   * Regression. A live panel sent every frame with `DeviceType: -1`, including
   * frames that plainly concerned contact sensors. Gating on the frame's own
   * claim silently disabled this decoding on real hardware, so the type must
   * come from discovery and the frame's value must not be consulted at all.
   */
  it.each([-1, 0, 99, SensorDeviceType.MOTION])(
    'decodes on the discovered type even when the frame reports DeviceType %s',
    (deviceType) => {
      const hint = readSensorEventHint(
        frame({ DeviceType: deviceType, EventType: ContactEventType.OPENED_AND_CLOSED }),
        'contact',
      )

      expect(hint).toEqual({ isTriggered: true, isTransient: true })
    },
  )
})
