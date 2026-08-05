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
    /** Emit the boot snapshot and arm the heartbeat. Idempotent. */
    start(): void;
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
 * Carries the plugin version and uptime because these lines are what users are
 * asked to attach to a bug report, and one that does not say which version
 * produced it starts with a round trip.
 *
 * The request and error counts mean different things on different channels —
 * per-interval on a heartbeat, cumulative on the start and stop snapshots — so
 * the window is named rather than left for the reader to infer.
 */
export declare function formatDiagnosticLine(report: DiagnosticsSnapshot): string;
//# sourceMappingURL=reporter.d.ts.map