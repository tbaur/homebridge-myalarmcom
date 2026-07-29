/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Push event stream over WebSocket.
 *
 * Alarm.com pushes panel and sensor activity over a WebSocket authenticated by
 * a short-lived token. The stream is treated strictly as a *hint*: an event
 * tells the platform which device changed, and the platform then re-reads that
 * device's real state. Decoding each event's payload into a state would mean
 * depending on several hundred undocumented event codes, and being wrong about
 * one of them in a security integration is not an acceptable failure mode.
 */
import { type AlarmComEvent } from '../types/events';
import type { Logger } from '../utils/logger';
import type { EventStreamToken } from './client';
export type { AlarmComEvent };
export interface EventStreamOptions {
    log: Logger;
    /** Fetches a fresh token and endpoint. Called on every (re)connect. */
    requestToken: () => Promise<EventStreamToken>;
    /** Invoked with the resource ID of the device an event concerns. */
    onDeviceEvent: (deviceResourceId: string, event: AlarmComEvent) => void;
    /** Invoked when the stream gives up, so the caller can lean on polling. */
    onUnavailable: () => void;
}
/** Maintains a live connection to the Alarm.com event stream. */
export declare class EventStream {
    #private;
    constructor(options: EventStreamOptions);
    /** Whether a socket is currently open. */
    get isConnected(): boolean;
    /** Open the stream and keep it open until {@link stop} is called. */
    start(): Promise<void>;
    /** Close the stream and cancel all timers. */
    stop(): void;
}
//# sourceMappingURL=event-stream.d.ts.map