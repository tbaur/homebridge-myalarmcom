"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Low-level HTTP transport shared by authentication and the API client.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.USER_AGENT = void 0;
exports.httpRequest = httpRequest;
const errors_1 = require("../errors");
const settings_1 = require("../settings");
const sanitizers_1 = require("../utils/sanitizers");
const version_1 = require("../utils/version");
/**
 * Identifies the plugin honestly rather than impersonating a browser.
 *
 * Verified acceptable: Alarm.com served the full API surface under this during
 * probe runs. If it ever starts refusing non-browser agents, that is a
 * deliberate signal from them and spoofing it would be the wrong response.
 *
 * The version is read from `package.json` rather than written here. A hardcoded
 * one silently went thirteen releases stale, which defeats the point of
 * identifying honestly and makes a bad release impossible to correlate.
 */
exports.USER_AGENT = `${settings_1.PLUGIN_NAME}/${version_1.PLUGIN_VERSION}`;
/**
 * Refuse to send session cookies anywhere but Alarm.com.
 *
 * Today every URL is a compile-time constant and redirects are not followed, so
 * this can never fire. That is precisely why it is here: the safety is
 * currently an emergent property of two unrelated decisions, and a future
 * change to either one should fail loudly rather than quietly replay a live
 * session cookie to a host of someone else's choosing.
 */
function assertCookieDestination(url, headers, redirect) {
    // Case-insensitive, because `fetch` normalises header names and a caller
    // writing `cookie` would otherwise send the whole session jar with this guard
    // silently skipped — a tripwire that only fires for one spelling is worse
    // than none, because it reads as though it covers both.
    const hasCookie = Object.keys(headers).some((name) => name.toLowerCase() === 'cookie');
    if (!hasCookie) {
        return;
    }
    // A followed redirect replays the request, cookies included, at a location the
    // server chose. `fetch` gives no hook to re-check each hop, so the only honest
    // control is to refuse the combination outright.
    if (redirect === 'follow') {
        throw new errors_1.NetworkError('Refusing to follow redirects on a request carrying session cookies');
    }
    let origin;
    try {
        origin = new URL(url).origin;
    }
    catch {
        throw new errors_1.NetworkError('Refusing to send session cookies to an unparseable URL');
    }
    if (origin !== settings_1.ALLOWED_API_ORIGIN) {
        throw new errors_1.NetworkError(`Refusing to send session cookies to ${(0, sanitizers_1.sanitizeUrl)(url)}`);
    }
}
/**
 * Perform an HTTP request with a hard timeout and consistent identification.
 *
 * @throws {TimeoutError} The request or its body read exceeded the deadline.
 * @throws {OperationAbortedError} The caller's signal aborted the request.
 * @throws {NetworkError} The request failed below the HTTP layer.
 */
async function httpRequest(url, options = {}) {
    const { method, headers, body, timeoutMs, signal, redirect } = { ...REQUEST_DEFAULTS, ...options };
    assertCookieDestination(url, headers, redirect);
    if (signal?.aborted === true) {
        throw new errors_1.OperationAbortedError(`Request to ${(0, sanitizers_1.sanitizeUrl)(url)} was cancelled before it started`);
    }
    const deadline = armDeadline(timeoutMs, signal);
    try {
        const response = await fetch(url, {
            method,
            redirect,
            headers: { 'User-Agent': exports.USER_AGENT, ...headers },
            ...(body === undefined ? {} : { body }),
            signal: deadline.signal,
        });
        // Read inside the deadline. An unconsumed body also holds its connection
        // out of undici's pool until the response is collected, which on a
        // four-minute keep-alive timer accumulates for the process lifetime.
        const text = await response.text();
        return { status: response.status, ok: response.ok, headers: response.headers, text };
    }
    catch (error) {
        // The cause is carried on every path, not just the network one: it is what
        // `sanitizeError` walks to surface the underlying failure, so dropping it
        // makes the wrapper strictly less useful than what it wrapped.
        const cause = error instanceof Error ? { cause: error } : undefined;
        if (deadline.isTimedOut) {
            throw new errors_1.TimeoutError(`Request to ${(0, sanitizers_1.sanitizeUrl)(url)} timed out after ${timeoutMs}ms`, cause);
        }
        if (deadline.isCancelled) {
            throw new errors_1.OperationAbortedError(`Request to ${(0, sanitizers_1.sanitizeUrl)(url)} was cancelled`, cause);
        }
        throw new errors_1.NetworkError(`Request to ${(0, sanitizers_1.sanitizeUrl)(url)} failed: ${(0, sanitizers_1.sanitizeError)(error)}`, cause);
    }
    finally {
        deadline.release();
    }
}
const REQUEST_DEFAULTS = {
    method: 'GET',
    headers: {},
    body: undefined,
    timeoutMs: settings_1.DEFAULT_REQUEST_TIMEOUT_MS,
    signal: undefined,
    redirect: 'manual',
};
/**
 * Arm a request deadline that also relays caller cancellation.
 *
 * Both reasons abort the same controller, and which one fired has to be recorded
 * separately: `fetch` reports every abort identically, so without this a shutdown
 * mid-request is indistinguishable from a timeout — and they are logged and
 * classified differently.
 */
function armDeadline(timeoutMs, signal) {
    const controller = new AbortController();
    const state = { isTimedOut: false, isCancelled: false };
    const timer = setTimeout(() => {
        state.isTimedOut = true;
        controller.abort();
    }, timeoutMs);
    const abortFromCaller = () => {
        state.isCancelled = true;
        controller.abort();
    };
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    return {
        signal: controller.signal,
        get isTimedOut() {
            return state.isTimedOut;
        },
        get isCancelled() {
            return state.isCancelled;
        },
        release: () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abortFromCaller);
        },
    };
}
//# sourceMappingURL=http.js.map