"use strict";
/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * @fileoverview Plugin entry point.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const platform_1 = require("./platform");
const settings_1 = require("./settings");
exports.default = (api) => {
    api.registerPlatform(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, platform_1.MyAlarmComPlatform);
};
//# sourceMappingURL=index.js.map