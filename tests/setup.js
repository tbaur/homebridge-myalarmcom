/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Jest setup shared by every suite.
 */

const { TLSSocket } = require('node:tls')
const nock = require('nock')

// Node 22's undici reads `parser.statusCode` from the error listener on a
// socket nock has already torn down. That listener throws, and Jest fails the
// suite after the tests have passed. Node 24 and later fixed undici.
const emitSocketEvent = TLSSocket.prototype.emit
TLSSocket.prototype.emit = function (event, ...args) {
  if (event !== 'error') {
    return emitSocketEvent.call(this, event, ...args)
  }
  try {
    return emitSocketEvent.call(this, event, ...args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("reading 'statusCode'")) {
      return false
    }
    throw error
  }
}

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
  nock.cleanAll()
  nock.enableNetConnect()
  // nock 15's restore() disposes the process-wide fetch interceptor.
  // Jest runs every file in one worker, and nothing can install that
  // interceptor again, so a later file would talk to the real network.
})
