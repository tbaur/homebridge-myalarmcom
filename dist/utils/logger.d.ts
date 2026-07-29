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
/** The subset of Homebridge's `Logging` this plugin uses. */
export interface Logger {
    debug(message: string, ...parameters: unknown[]): void;
    info(message: string, ...parameters: unknown[]): void;
    warn(message: string, ...parameters: unknown[]): void;
    error(message: string, ...parameters: unknown[]): void;
}
/**
 * Wrap a logger so messages and parameters are stripped of secrets.
 *
 * @param _scope Retained for call-site documentation only (auth, events, …).
 *   Not written into the log line — Homebridge already scopes by plugin name.
 * @param isDebugEnabled When false, `debug` calls are dropped entirely rather
 *   than delegated, so verbose paths cost nothing in normal operation.
 */
export declare function createScopedLogger(base: Logger, _scope: string, isDebugEnabled: boolean): Logger;
//# sourceMappingURL=logger.d.ts.map