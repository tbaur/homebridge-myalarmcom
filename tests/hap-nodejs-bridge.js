/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Jest's module map points `@homebridge/hap-nodejs` here. The real package is
 * ESM from 2.3, which the test vm cannot load on Node 22; tests/preload-esm.js
 * already loaded it in Node.
 */

const hap = globalThis.__HAP_NODEJS__

if (!hap) {
  throw new Error('@homebridge/hap-nodejs was not preloaded. Test scripts must pass --require=./tests/preload-esm.js')
}

module.exports = hap
