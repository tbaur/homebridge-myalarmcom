/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Jest compiles tests inside vm, and vm cannot require() an ES module before
 * Node 24.9. Node itself can, since 22.12. Test scripts pass --require for this
 * file so it runs before Jest, and a bridge file in tests/ hands each loaded
 * module to the suite through Jest's moduleNameMapper.
 *
 * nock is ESM. @homebridge/hap-nodejs is ESM from 2.3.
 */

const loaded = require('nock')
const nock = loaded.default ?? loaded

if (typeof nock !== 'function' || typeof nock.disableNetConnect !== 'function') {
  throw new Error('nock did not load')
}

const hap = require('@homebridge/hap-nodejs')

if (typeof hap.Service !== 'function' || typeof hap.HapStatusError !== 'function') {
  throw new Error('@homebridge/hap-nodejs did not load')
}

globalThis.__NOCK__ = nock
globalThis.__HAP_NODEJS__ = hap
