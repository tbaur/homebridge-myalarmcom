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
import type { EventStreamToken } from '../types/alarm';
import { type AlarmComEvent } from '../types/events';
import type { Logger } from '../utils/logger';
export type { AlarmComEvent };
export interface EventStreamOptions {
    log: Logger;
    /** Fetches a fresh token and endpoint. Called on every (re)connect. */
    requestToken: () => Promise<EventStreamToken>;
    /** Invoked with the resource ID of the device an event concerns. */
    onDeviceEvent: (deviceResourceId: string, event: AlarmComEvent) => void;
    /** Invoked when the stream gives up, so the caller can lean on polling. */
    onUnavailable: () => void;
    /** Invoked when the stream reconnects after a prior disconnect. */
    onReconnect?: () => void;
    /** Invoked when the stream resumes after a prior give-up. */
    onRecovered?: () => void;
}
/** Live status of the event stream, for diagnostics. */
export interface EventStreamStatus {
    isConnected: boolean;
    isConnecting: boolean;
    isClosed: boolean;
    lastEventAgeSec: number | null;
    /**
     * Seconds since the live socket was lost.
     *
     * `null` while connected, or before the stream has ever connected. Health
     * uses this — not {@link lastEventAgeSec} — so a quiet house does not look
     * like an outage the moment the socket blips.
     */
    disconnectAgeSec: number | null;
}
/** Maintains a live connection to the Alarm.com event stream. */
export declare class EventStream {
    #private;
    constructor(options: EventStreamOptions);
    /** Whether a socket is currently open. */
    get isConnected(): boolean;
    /** In-memory status for diagnostics; never touches the network. */
    getStatus(): EventStreamStatus;
    /** Open the stream and keep it open until {@link stop} is called. */
    start(): Promise<void>;
    /** Close the stream and cancel all timers. */
    stop(): void;
}
//# sourceMappingURL=event-stream.d.ts.map