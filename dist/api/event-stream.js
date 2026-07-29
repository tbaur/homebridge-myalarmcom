"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventStream = void 0;
const ws_1 = __importDefault(require("ws"));
const settings_1 = require("../settings");
const events_1 = require("../types/events");
const retry_1 = require("../utils/retry");
/** Maintains a live connection to the Alarm.com event stream. */
class EventStream {
    #log;
    #requestToken;
    #onDeviceEvent;
    #onUnavailable;
    #onReconnect;
    #socket = null;
    #reconnectTimer = null;
    #refreshTimer = null;
    #consecutiveFailures = 0;
    #isStopped = false;
    /** Whether a failure reason has already been surfaced at warn level. */
    #hasReportedFailure = false;
    #isConnecting = false;
    #hadConnected = false;
    #lastEventAt = null;
    constructor(options) {
        this.#log = options.log;
        this.#requestToken = options.requestToken;
        this.#onDeviceEvent = options.onDeviceEvent;
        this.#onUnavailable = options.onUnavailable;
        this.#onReconnect = options.onReconnect;
    }
    /** Whether a socket is currently open. */
    get isConnected() {
        return this.#socket?.readyState === ws_1.default.OPEN;
    }
    /** In-memory status for diagnostics; never touches the network. */
    getStatus() {
        const isConnected = this.isConnected;
        return {
            isConnected,
            isConnecting: this.#isConnecting && !isConnected,
            isClosed: this.#isStopped || this.#socket?.readyState === ws_1.default.CLOSED,
            lastEventAgeSec: this.#lastEventAt === null
                ? null
                : Math.round((Date.now() - this.#lastEventAt) / 1000),
        };
    }
    /** Open the stream and keep it open until {@link stop} is called. */
    async start() {
        this.#isStopped = false;
        await this.#connect();
    }
    /** Close the stream and cancel all timers. */
    stop() {
        this.#isStopped = true;
        this.#clearTimers();
        if (this.#socket) {
            // Remove listeners first so the close does not schedule a reconnect.
            this.#socket.removeAllListeners();
            this.#socket.close();
            this.#socket = null;
        }
    }
    #clearTimers() {
        if (this.#reconnectTimer) {
            clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }
        if (this.#refreshTimer) {
            clearTimeout(this.#refreshTimer);
            this.#refreshTimer = null;
        }
    }
    /**
     * Decide which host the stream token may be sent to.
     *
     * The endpoint arrives inside a JSON response, and the token is appended to
     * it as a query parameter. Using it unchecked means whoever controls that one
     * field controls where a live credential for a home security system is sent,
     * and a `ws://` value would additionally send it in clear text. Neither is
     * acceptable for a value this sensitive, so an endpoint that is not TLS on an
     * Alarm.com host is refused in favour of the known-good default.
     */
    #resolveEndpoint(endpoint) {
        if (!endpoint) {
            return settings_1.DEFAULT_WEBSOCKET_ENDPOINT;
        }
        try {
            const { protocol, hostname } = new URL(endpoint);
            const isAlarmComHost = hostname === settings_1.WEBSOCKET_HOST_SUFFIX.slice(1)
                || hostname.endsWith(settings_1.WEBSOCKET_HOST_SUFFIX);
            if (protocol === 'wss:' && isAlarmComHost) {
                return endpoint;
            }
            this.#log.warn(`Ignoring an event stream endpoint Alarm.com reported as ${protocol}//${hostname}, `
                + 'which is not a secure alarm.com address. Using the default instead.');
        }
        catch {
            this.#log.warn('Ignoring an unparseable event stream endpoint. Using the default instead.');
        }
        return settings_1.DEFAULT_WEBSOCKET_ENDPOINT;
    }
    async #connect() {
        if (this.#isStopped) {
            return;
        }
        this.#isConnecting = true;
        try {
            const { token, endpoint } = await this.#requestToken();
            const target = this.#resolveEndpoint(endpoint);
            // The token must be appended raw. It is not an opaque value: it arrives
            // already percent-escaped and containing structural `&` and `=`, so it
            // expands into several query parameters rather than one. Encoding it
            // turns those separators into literals and the upgrade is refused with
            // HTTP 401. Verified against a live account with both this client and
            // Node's built-in one.
            const url = `${target}?auth=${token}`;
            this.#log.debug(`connecting to the event stream at ${target}`);
            const socket = new ws_1.default(url);
            this.#socket = socket;
            socket.on('open', () => this.#handleOpen());
            socket.on('message', (data) => this.#handleMessage(data));
            socket.on('error', (error) => this.#recordFailureReason(error.message));
            socket.on('close', (code) => this.#handleClose(code));
            // Emitted when the HTTP upgrade is rejected. The status code is the one
            // piece of information that distinguishes a bad token from a blocked
            // client, and it is not available anywhere else.
            socket.on('unexpected-response', (_request, response) => {
                this.#recordFailureReason(`the server refused the connection upgrade with HTTP ${response.statusCode}`);
            });
        }
        catch (error) {
            this.#isConnecting = false;
            this.#recordFailureReason(`could not obtain a stream token: ${String(error)}`);
            this.#scheduleReconnect();
        }
    }
    /**
     * Report why the stream failed.
     *
     * The first reason is surfaced at warn level and the rest at debug. Logging
     * every attempt loudly would be noise, but logging none of them loudly means
     * a user sees the stream give up with no indication of why, which is a
     * genuinely unhelpful place to leave someone.
     */
    #recordFailureReason(reason) {
        if (this.#hasReportedFailure) {
            this.#log.debug(`event stream: ${reason}`);
            return;
        }
        this.#hasReportedFailure = true;
        this.#log.warn(`Alarm.com event stream could not connect: ${reason}`);
    }
    #handleOpen() {
        this.#isConnecting = false;
        this.#consecutiveFailures = 0;
        this.#hasReportedFailure = false;
        // Count recoveries, not the first successful open.
        if (this.#hadConnected) {
            this.#log.info('Alarm.com event stream reconnected');
            this.#onReconnect?.();
        }
        else {
            this.#log.info('Alarm.com event stream connected');
        }
        this.#hadConnected = true;
        this.#scheduleRefresh();
    }
    /**
     * Proactively reconnect before the token expires.
     *
     * A silently dead socket is worse than a briefly interrupted one: HomeKit
     * would keep showing stale state with nothing logged anywhere. Jitter keeps
     * multiple Homebridge instances from reconnecting in unison.
     */
    #scheduleRefresh() {
        if (this.#refreshTimer) {
            clearTimeout(this.#refreshTimer);
        }
        const jitter = Math.random() * settings_1.WEBSOCKET_REFRESH_JITTER_MS;
        this.#refreshTimer = setTimeout(() => {
            this.#log.debug('refreshing the event stream connection');
            this.#reconnect();
        }, settings_1.WEBSOCKET_REFRESH_INTERVAL_MS + jitter);
    }
    #handleClose(code) {
        if (this.#isStopped) {
            return;
        }
        this.#log.debug(`event stream closed with code ${code}`);
        this.#scheduleReconnect();
    }
    #reconnect() {
        if (this.#socket) {
            this.#socket.removeAllListeners();
            this.#socket.close();
            this.#socket = null;
        }
        void this.#connect();
    }
    #scheduleReconnect() {
        if (this.#isStopped || this.#reconnectTimer) {
            return;
        }
        this.#consecutiveFailures++;
        if (this.#consecutiveFailures > settings_1.WEBSOCKET_MAX_FAILURES) {
            this.#log.warn(`The Alarm.com event stream failed ${this.#consecutiveFailures} times; falling back to polling for state updates.`);
            this.#onUnavailable();
            return;
        }
        const delayMs = (0, retry_1.computeBackoffMs)(this.#consecutiveFailures, settings_1.WEBSOCKET_RECONNECT_BASE_MS, settings_1.WEBSOCKET_RECONNECT_MAX_MS);
        this.#log.debug(`reconnecting to the event stream in ${Math.round(delayMs / 1000)}s`);
        this.#reconnectTimer = setTimeout(() => {
            this.#reconnectTimer = null;
            void this.#connect();
        }, delayMs);
    }
    #handleMessage(data) {
        let event;
        try {
            event = JSON.parse(data.toString());
        }
        catch {
            this.#log.debug('discarding an unparseable event stream frame');
            return;
        }
        if (typeof event?.UnitId !== 'number' || typeof event?.DeviceId !== 'number') {
            return;
        }
        if (event.EventType === events_1.EVENT_TYPE_USER_LOGGED_IN) {
            return;
        }
        // Device resource IDs are the unit and device numbers joined by a hyphen,
        // e.g. unit 1234 device 17 is sensor "1234-17".
        const deviceResourceId = `${event.UnitId}-${event.DeviceId}`;
        this.#lastEventAt = Date.now();
        this.#log.debug(`event type ${event.EventType} for device ${deviceResourceId}`);
        this.#onDeviceEvent(deviceResourceId, event);
    }
}
exports.EventStream = EventStream;
//# sourceMappingURL=event-stream.js.map