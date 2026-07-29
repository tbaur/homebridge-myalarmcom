/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Alarm.com push event frames, and the narrow subset this plugin decodes.
 */
import type { SensorServiceKind } from '../utils/mappers';
/** A single frame from the Alarm.com event stream. */
export interface AlarmComEvent {
    EventDateUtc: string;
    /** Panel identifier. Device resource IDs are `${UnitId}-${DeviceId}`. */
    UnitId: number;
    DeviceId: number;
    EventType: number;
    EventValue: number;
    CorrelatedId: number | null;
    /** Query-string-encoded extras. May contain account detail; never logged raw. */
    QstringForExtraData: string | null;
    /**
     * Unreliable. Observed as `-1` on live frames that plainly concerned a
     * contact sensor, so it must not be used to decide what a device is. Resolve
     * the type from discovery instead.
     */
    DeviceType: number;
}
/**
 * Event type indicating a user signed in to Alarm.com.
 *
 * Carries no device state and fires on this plugin's own logins, so it is
 * filtered out rather than triggering a pointless refresh.
 */
export declare const EVENT_TYPE_USER_LOGGED_IN = 55;
/**
 * The only event types this plugin interprets.
 *
 * Alarm.com's enumeration runs to several hundred values and is undocumented.
 * These three are decoded because all three were observed on live hardware and
 * their meaning is unambiguous. Everything else is deliberately left alone;
 * see {@link readSensorEventHint}.
 */
export declare enum ContactEventType {
    CLOSED = 0,
    OPENED = 15,
    /** A single frame meaning the sensor opened *and* closed again. */
    OPENED_AND_CLOSED = 100
}
/** An immediate state change inferred from an event, ahead of the re-read. */
export interface ImmediateStateHint {
    /** State to publish right now. */
    isTriggered: boolean;
    /**
     * Whether the event already implies a return to rest.
     *
     * True for an open-and-close, where publishing "open" is correct only as a
     * momentary pulse that the confirming re-read will clear.
     */
    isTransient: boolean;
}
/**
 * Decode an event into an immediate state change, when it is safe to do so.
 *
 * Re-reading the device after an event is the plugin's normal path and is
 * strictly more trustworthy, but it costs one to two seconds. A door opened
 * and shut inside that window reports `Closed` by the time the read lands, so
 * HomeKit never sees it open and automations on "door opens" never fire.
 *
 * Decoding these three contact events closes that hole without giving up the
 * safety argument: the re-read still runs and still wins, so a wrong guess here
 * self-corrects within seconds rather than persisting. Anything not listed
 * returns `undefined` and takes the re-read-only path unchanged.
 *
 * `kind` is the device's type as established at discovery, deliberately not
 * `event.DeviceType`. Live frames were observed carrying `DeviceType: -1` on a
 * real panel, so trusting the frame silently disabled this decoding for the
 * cases it exists to serve. What the API said the device is does not change
 * between frames; what the frame claims does.
 */
export declare function readSensorEventHint(event: AlarmComEvent, kind: SensorServiceKind | undefined): ImmediateStateHint | undefined;
//# sourceMappingURL=events.d.ts.map