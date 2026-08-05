/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Resolves the installed plugin version.
 */
/**
 * The plugin's own version, resolved once at load.
 *
 * Shared rather than resolved per caller so the diagnostics report and the
 * `User-Agent` can never disagree about which build is running — which is
 * exactly what a stale hardcoded version had already caused.
 */
export declare const PLUGIN_VERSION: string;
//# sourceMappingURL=version.d.ts.map