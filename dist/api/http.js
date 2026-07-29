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
/**
 * Identifies the plugin honestly rather than impersonating a browser.
 *
 * Verified acceptable: Alarm.com served the full API surface under this during
 * probe runs. If it ever starts refusing non-browser agents, that is a
 * deliberate signal from them and spoofing it would be the wrong response.
 */
exports.USER_AGENT = 'homebridge-myalarmcom/0.1.0';
/**
 * Perform an HTTP request with a hard timeout and consistent identification.
 *
 * @throws {TimeoutError} The request exceeded its deadline.
 * @throws {NetworkError} The request failed below the HTTP layer.
 */
async function httpRequest(url, options = {}) {
    const { method = 'GET', headers = {}, body, timeoutMs = settings_1.DEFAULT_REQUEST_TIMEOUT_MS, redirect = 'manual', } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            method,
            redirect,
            headers: { 'User-Agent': exports.USER_AGENT, ...headers },
            body,
            signal: controller.signal,
        });
    }
    catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new errors_1.TimeoutError(`Request to ${(0, sanitizers_1.sanitizeUrl)(url)} timed out after ${timeoutMs}ms`);
        }
        throw new errors_1.NetworkError(`Request to ${(0, sanitizers_1.sanitizeUrl)(url)} failed: ${(0, sanitizers_1.sanitizeError)(error)}`, error instanceof Error ? { cause: error } : undefined);
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=http.js.map