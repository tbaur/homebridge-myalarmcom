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
 */
import type { ConfigValidationResult, MyAlarmComPlatformConfig } from '../types/config';
/**
 * Validate and normalise the user's platform configuration.
 *
 * @throws {ConfigurationError} When a required value is missing or unusable.
 */
export declare function validateConfig(raw: MyAlarmComPlatformConfig): ConfigValidationResult;
//# sourceMappingURL=validators.d.ts.map