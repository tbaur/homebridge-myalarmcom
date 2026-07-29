"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Logging wrapper that enforces redaction.
 *
 * Every log line the plugin emits passes through here, so redaction cannot be
 * forgotten at an individual call site. Messages are not component-prefixed:
 * Homebridge already tags lines with the plugin name (e.g. `[myalarmcom]`).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createScopedLogger = createScopedLogger;
const sanitizers_1 = require("./sanitizers");
/**
 * Wrap a logger so messages and parameters are stripped of secrets.
 *
 * @param _scope Retained for call-site documentation only (auth, events, …).
 *   Not written into the log line — Homebridge already scopes by plugin name.
 * @param isDebugEnabled When false, `debug` calls are dropped entirely rather
 *   than delegated, so verbose paths cost nothing in normal operation.
 */
function createScopedLogger(base, _scope, isDebugEnabled) {
    const format = (message) => (0, sanitizers_1.sanitizeString)(message);
    // Parameters are redacted too. Sanitizing only the message left the wrapper
    // claiming a guarantee it did not provide: `log.debug('cookies', header)`
    // handed the header straight to Homebridge untouched.
    const clean = (parameters) => parameters.map(sanitizers_1.sanitizeLogParameter);
    return {
        debug: isDebugEnabled
            ? (message, ...parameters) => base.debug(format(message), ...clean(parameters))
            : () => undefined,
        info: (message, ...parameters) => base.info(format(message), ...clean(parameters)),
        warn: (message, ...parameters) => base.warn(format(message), ...clean(parameters)),
        error: (message, ...parameters) => base.error(format(message), ...clean(parameters)),
    };
}
//# sourceMappingURL=logger.js.map