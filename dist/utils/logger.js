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
 * forgotten at an individual call site. Homebridge tags each line with the
 * plugin name; this adds the component within the plugin, so a stream problem
 * can be told apart from an auth problem without reading the message text.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createScopedLogger = createScopedLogger;
const sanitizers_1 = require("./sanitizers");
/**
 * Wrap a log sink so messages and parameters are stripped of secrets.
 *
 * Always wrap the *raw* sink. Wrapping an already-scoped logger runs the whole
 * pattern set twice on every line — in the polling hot path — and produces a
 * doubled `[platform] [partition]` prefix.
 *
 * @param scope Component this logger belongs to (auth, events, partition, …),
 *   written into the line as a `[scope]` prefix.
 * @param isDebugEnabled When false, `debug` calls are dropped entirely rather
 *   than delegated, so verbose paths cost nothing in normal operation.
 */
function createScopedLogger(base, scope, isDebugEnabled) {
    const format = (message) => `[${scope}] ${(0, sanitizers_1.sanitizeString)(message)}`;
    // Parameters are redacted too. Sanitizing only the message left the wrapper
    // claiming a guarantee it did not provide: `log.debug('cookies', header)`
    // handed the header straight to Homebridge untouched.
    const clean = (parameters) => parameters.map(sanitizers_1.sanitizeLogParameter);
    return {
        isDebugEnabled,
        debug: isDebugEnabled
            ? (message, ...parameters) => base.debug(format(message), ...clean(parameters))
            : () => undefined,
        info: (message, ...parameters) => base.info(format(message), ...clean(parameters)),
        warn: (message, ...parameters) => base.warn(format(message), ...clean(parameters)),
        error: (message, ...parameters) => base.error(format(message), ...clean(parameters)),
    };
}
//# sourceMappingURL=logger.js.map