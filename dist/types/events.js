"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Alarm.com push event frames, and the narrow subset this plugin decodes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContactEventType = exports.EVENT_TYPE_USER_LOGGED_IN = void 0;
exports.readSensorEventHint = readSensorEventHint;
/**
 * Event type indicating a user signed in to Alarm.com.
 *
 * Carries no device state and fires on this plugin's own logins, so it is
 * filtered out rather than triggering a pointless refresh.
 */
exports.EVENT_TYPE_USER_LOGGED_IN = 55;
/**
 * The only event types this plugin interprets.
 *
 * Alarm.com's enumeration runs to several hundred values and is undocumented.
 * `CLOSED` and `OPENED_AND_CLOSED` were observed on live hardware; `OPENED` is
 * inferred from its pairing with them. Everything else is deliberately left
 * alone; see {@link readSensorEventHint} and docs/PROTOCOL.md.
 */
var ContactEventType;
(function (ContactEventType) {
    ContactEventType[ContactEventType["CLOSED"] = 0] = "CLOSED";
    ContactEventType[ContactEventType["OPENED"] = 15] = "OPENED";
    /** A single frame meaning the sensor opened *and* closed again. */
    ContactEventType[ContactEventType["OPENED_AND_CLOSED"] = 100] = "OPENED_AND_CLOSED";
})(ContactEventType || (exports.ContactEventType = ContactEventType = {}));
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
function readSensorEventHint(event, kind) {
    // Scoped to contact sensors. The same numeric codes are not known to carry
    // the same meaning on other device types, and guessing is what this avoids.
    if (kind !== 'contact') {
        return undefined;
    }
    switch (event.EventType) {
        case ContactEventType.OPENED:
            return { isTriggered: true, isTransient: false };
        case ContactEventType.CLOSED:
            return { isTriggered: false, isTransient: false };
        case ContactEventType.OPENED_AND_CLOSED:
            return { isTriggered: true, isTransient: true };
        default:
            return undefined;
    }
}
//# sourceMappingURL=events.js.map