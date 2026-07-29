/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Jest setup shared by every suite.
 */

const nock = require('nock')

// No test may reach the network. Alarm.com locks accounts that see unexpected
// traffic, so a stray real request from a test run is a genuine hazard rather
// than merely a flaky test.
beforeAll(() => {
  nock.disableNetConnect()
})

afterEach(() => {
  nock.cleanAll()
})

afterAll(() => {
  nock.enableNetConnect()
  nock.restore()
})
