"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Turns diagnostics reports into Homebridge log lines.
 *
 * Split from the platform because it is a self-contained concern: the platform
 * owns devices and their lifecycle, this owns a timer, a health edge detector,
 * and a line format. Nothing here may throw into its caller — diagnostics that
 * can take down the thing they are diagnosing are worse than no diagnostics.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiagnosticsReporter = void 0;
exports.formatDiagnosticLine = formatDiagnosticLine;
const sanitizers_1 = require("../utils/sanitizers");
/** Emits the boot snapshot, periodic heartbeats, and health transitions. */
class DiagnosticsReporter {
    #collector;
    #readers;
    #log;
    #intervalMs;
    #timer = null;
    #lastHealth = null;
    constructor(options) {
        this.#collector = options.collector;
        this.#readers = options.readers;
        this.#log = options.log;
        this.#intervalMs = options.intervalMs;
    }
    /** Whether the user asked for heartbeats at all. */
    get isEnabled() {
        return this.#intervalMs > 0;
    }
    /** Emit the boot snapshot and arm the heartbeat. Idempotent. */
    start() {
        if (!this.isEnabled || this.#timer) {
            return;
        }
        this.#guard('start snapshot', () => {
            const report = this.#collector.snapshot('diagnostics.start', this.#readers);
            this.#lastHealth = report.lifecycle.health;
            this.#emit('info', report);
        });
        this.#timer = setInterval(() => this.heartbeat(), this.#intervalMs);
        // Cleared on shutdown, but unref'd so a missed shutdown cannot keep the
        // process alive on a diagnostics timer.
        this.#timer.unref?.();
    }
    /** Clear the heartbeat and emit the shutdown snapshot. Idempotent. */
    stop() {
        const timer = this.#timer;
        this.#timer = null;
        if (!timer) {
            return;
        }
        clearInterval(timer);
        this.#guard('stop snapshot', () => {
            this.#emit('info', this.#collector.snapshot('diagnostics.stop', this.#readers));
        });
    }
    /**
     * Emit one heartbeat, plus a transition line when health changed.
     *
     * The recovered line matters as much as the degraded one: a log that only
     * ever reports failures cannot tell you whether the problem is still there.
     */
    heartbeat() {
        this.#guard('heartbeat', () => {
            const report = this.#collector.buildHeartbeat(this.#readers);
            this.#emit('info', report);
            const health = report.lifecycle.health;
            if (this.#lastHealth !== null && health !== this.#lastHealth) {
                const isDegraded = health === 'degraded';
                this.#emit(isDegraded ? 'warn' : 'info', {
                    ...report,
                    msg: isDegraded ? 'health.degraded' : 'health.recovered',
                });
            }
            this.#lastHealth = health;
        });
    }
    #guard(what, action) {
        try {
            action();
        }
        catch (error) {
            this.#log.debug(`Diagnostics ${what} failed: ${(0, sanitizers_1.sanitizeError)(error)}`);
        }
    }
    /**
     * Emit a report as a human-readable line, with the payload on a debug line.
     *
     * Homebridge's logger stringifies extra arguments onto the same line, so
     * passing the structured snapshot as a second argument produced the giant
     * JSON blob users saw after every Health line.
     */
    #emit(level, report) {
        this.#log[level](formatDiagnosticLine(report));
        // Guarded rather than merely dropped: the spreads below run before the
        // no-op debug call would, so an unguarded version pays for a payload
        // nobody will read on every heartbeat.
        if (!this.#log.isDebugEnabled) {
            return;
        }
        const { lifecycle, msg, ...groups } = report;
        this.#log.debug('Diagnostics snapshot', { msg, ...groups, ...lifecycle });
    }
}
exports.DiagnosticsReporter = DiagnosticsReporter;
/** Human-readable label for a diagnostics channel. */
function diagnosticLabel(msg) {
    switch (msg) {
        case 'health':
            return 'Health';
        case 'diagnostics.start':
            return 'Diagnostics start';
        case 'diagnostics.stop':
            return 'Diagnostics stop';
        case 'health.degraded':
            return 'Health degraded';
        case 'health.recovered':
            return 'Health recovered';
    }
}
/**
 * Concise human-readable summary line for a diagnostics report.
 *
 * Carries the plugin version and uptime because these lines are what users are
 * asked to attach to a bug report, and one that does not say which version
 * produced it starts with a round trip.
 *
 * The request and error counts mean different things on different channels —
 * per-interval on a heartbeat, cumulative on the start and stop snapshots — so
 * the window is named rather than left for the reader to infer.
 */
function formatDiagnosticLine(report) {
    const { lifecycle, devices, websocket, api } = report;
    const reasonText = lifecycle.reasons.length > 0 ? ` [${lifecycle.reasons.join(', ')}]` : '';
    const window = report.msg === 'health' ? 'interval' : 'session';
    return (`${diagnosticLabel(report.msg)}: ${lifecycle.health}${reasonText} | `
        + `v${lifecycle.pluginVersion} up ${lifecycle.uptimeSec}s | `
        + `devices ${devices.partitions}p/${devices.sensors}s | `
        + `ws ${websocket.state} | `
        + `api p50 ${api.p50Ms}ms p95 ${api.p95Ms}ms `
        + `(req ${api.requests}, err ${api.errors} this ${window})`);
}
//# sourceMappingURL=reporter.js.map