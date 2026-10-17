/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Jest compiles tests inside vm, and vm cannot require() an ES module.
 * Node itself can, since 22.12. Test scripts pass --require for this file
 * so it runs before Jest, and tests/nock-bridge.js hands the loaded module
 * to the suite.
 */

const loaded = require('nock')
const nock = loaded.default ?? loaded

if (typeof nock !== 'function' || typeof nock.disableNetConnect !== 'function') {
  throw new Error('nock did not load')
}

globalThis.__NOCK__ = nock
