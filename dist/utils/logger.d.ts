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
/** Somewhere log lines can be written. Homebridge's `Logging` satisfies this. */
export interface LogSink {
    debug(message: string, ...parameters: unknown[]): void;
    info(message: string, ...parameters: unknown[]): void;
    warn(message: string, ...parameters: unknown[]): void;
    error(message: string, ...parameters: unknown[]): void;
}
/** A redacting, component-scoped logger. */
export interface Logger extends LogSink {
    /**
     * Whether debug output is enabled.
     *
     * Exposed so callers can skip building a payload that would be discarded.
     * Dropping the `debug` call is not enough on its own: JavaScript evaluates
     * the argument before the call, so an expensive template literal is paid for
     * even when the line is never written.
     */
    readonly isDebugEnabled: boolean;
}
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
export declare function createScopedLogger(base: LogSink, scope: string, isDebugEnabled: boolean): Logger;
//# sourceMappingURL=logger.d.ts.map