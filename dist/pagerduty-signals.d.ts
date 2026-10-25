export type SignalSeverity = 'info' | 'warning' | 'error' | 'critical';
export interface SignalState {
    active: boolean;
    severity: SignalSeverity;
    summary: string;
}
export interface PagerDutySignalsOptions {
    /** This plugin's npm package name, exactly as in package.json. */
    plugin: string;
    /** `api.user.storagePath()` */
    storagePath: string;
    log: {
        warn(message: string): void;
    };
}
/**
 * Writes this plugin's conditions to the homebridge-pagerduty signal store.
 * Never throws: a failure is logged once, and the next write tries again.
 */
export declare class PagerDutySignals {
    private readonly options;
    private db;
    private readonly lastWritten;
    private isDisabled;
    private hasWarned;
    constructor(options: PagerDutySignalsOptions);
    /** Record a signal's current state. Skipped when nothing changed since the last write. */
    write(signal: string, state: SignalState): void;
    /** Close the connection. Call on Homebridge `shutdown`. Never clears a signal. */
    close(): void;
    private open;
    private disable;
    private warnOnce;
}
//# sourceMappingURL=pagerduty-signals.d.ts.map