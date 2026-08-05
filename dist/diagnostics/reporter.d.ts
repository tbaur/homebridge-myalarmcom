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
import type { Logger } from '../utils/logger';
import type { DiagnosticsCollector, DiagnosticsReaders } from './collector';
import type { DiagnosticsSnapshot } from './types';
export interface DiagnosticsReporterOptions {
    collector: DiagnosticsCollector;
    readers: DiagnosticsReaders;
    log: Logger;
    /** Milliseconds between heartbeats. `0` disables reporting entirely. */
    intervalMs: number;
}
/** Emits the boot snapshot, periodic heartbeats, and health transitions. */
export declare class DiagnosticsReporter {
    #private;
    constructor(options: DiagnosticsReporterOptions);
    /** Whether the user asked for heartbeats at all. */
    get isEnabled(): boolean;
    /**
     * Emit the boot snapshot and arm the heartbeat. Idempotent.
     *
     * Call after the platform is Ready so the start line reflects discovered
     * devices and stream state, not zeros from before discovery.
     */
    start(): void;
    /**
     * Debug-only snapshot when startup never reaches Ready.
     *
     * The INFO start line waits until after discovery so it is not a wall of
     * zeros. A permanent boot failure still needs a config echo for bug reports;
     * that lands here at debug (requires Homebridge `-D` plus `debug: true`).
     */
    noteBootFailure(): void;
    /** Clear the heartbeat and emit the shutdown snapshot. Idempotent. */
    stop(): void;
    /**
     * Emit one heartbeat, plus a transition line when health changed.
     *
     * The recovered line matters as much as the degraded one: a log that only
     * ever reports failures cannot tell you whether the problem is still there.
     */
    heartbeat(): void;
}
/**
 * Concise human-readable summary line for a diagnostics report.
 *
 * Kept short on purpose: these lines are scanned in a busy Homebridge log.
 * Version/uptime live in the debug snapshot payload (and in the child-bridge
 * banner), not on every heartbeat.
 */
export declare function formatDiagnosticLine(report: DiagnosticsSnapshot): string;
//# sourceMappingURL=reporter.d.ts.map