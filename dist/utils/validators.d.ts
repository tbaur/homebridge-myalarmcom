/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Configuration validation.
 *
 * Alarm.com punishes misconfiguration harshly: too-frequent polling or repeated
 * logins can get an account locked, which takes the alarm panel's app access
 * down with it. Values are therefore clamped to safe floors rather than trusted,
 * and the user is told when a clamp was applied.
 *
 * Nothing here throws. Homebridge does not guard a platform constructor, so a
 * thrown error escapes `loadPlatforms()` and terminates the whole bridge —
 * every other plugin and every other accessory in the house — over one typo in
 * this plugin's block. Fatal problems are returned as `errors` instead, and the
 * platform reports them and stays inert.
 */
import type { ConfigValidationResult, MyAlarmComPlatformConfig } from '../types/config';
/**
 * Validate and normalise the user's platform configuration.
 *
 * @returns `config` is `null` when a fatal problem was found; `errors` then
 *   explains what the user must fix.
 */
export declare function validateConfig(raw: MyAlarmComPlatformConfig): ConfigValidationResult;
//# sourceMappingURL=validators.d.ts.map