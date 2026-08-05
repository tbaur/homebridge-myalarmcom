"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Resolves the installed plugin version.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLUGIN_VERSION = void 0;
/**
 * Installed plugin version, or `unknown` if it cannot be read.
 *
 * Resolved via `require` rather than a static `import`: `package.json` lives
 * outside the TypeScript `rootDir` (`src/`), so importing it would alter the
 * emitted `dist/` layout. The require resolves correctly from both the compiled
 * `dist/` output and ts-jest.
 */
function readPluginVersion() {
    try {
        return require('../../package.json').version || 'unknown';
    }
    catch {
        return 'unknown';
    }
}
/**
 * The plugin's own version, resolved once at load.
 *
 * Shared rather than resolved per caller so the diagnostics report and the
 * `User-Agent` can never disagree about which build is running — which is
 * exactly what a stale hardcoded version had already caused.
 */
exports.PLUGIN_VERSION = readPluginVersion();
//# sourceMappingURL=version.js.map