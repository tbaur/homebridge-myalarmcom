/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Jest's module map points `nock` here. The real package is ESM, which the
 * test vm cannot load; tests/preload-nock.js already loaded it in Node.
 */

const nock = globalThis.__NOCK__

if (!nock) {
  throw new Error('nock was not preloaded. Test scripts must pass --require=./tests/preload-nock.js')
}

module.exports = nock
