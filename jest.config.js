/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * Jest configuration for sandboxed testing.
 * All tests run in isolation against captured fixtures; none touch the network.
 *
 * The `test` scripts in package.json set `NODE_OPTIONS=--experimental-vm-modules`.
 * The suite itself is CommonJS, but the PII scrubber that decides what may be
 * committed lives in an `.mjs` development script, and testing a control of
 * that kind matters more than keeping the runner on defaults.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',

  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      // Tests compile under the same strict settings as production
      // (see tsconfig.test.json) so type errors are caught consistently.
      tsconfig: 'tsconfig.test.json',
    }],
  },

  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],

  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,

  maxWorkers: 1,

  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    // Only the entry point, not every index.ts. The glob form also caught
    // `src/errors/index.ts`, which is the error hierarchy rather than a
    // barrel, so `createApiError` and the retry hints it sets were tested but
    // never counted against the threshold.
    '!src/index.ts',
    '!src/settings.ts', // Constants only
  ],

  testMatch: [
    '**/tests/unit/**/*.test.ts',
    '**/tests/integration/**/*.test.ts',
  ],

  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
  ],

  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },

  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],

  testTimeout: 10000,
  verbose: true,
  // forceExit guarantees a clean shutdown after the suite. detectOpenHandles is
  // intentionally left off the standing config: it is a debugging aid (run via
  // `jest --detectOpenHandles` when chasing a hang) that reports false positives
  // for nock 14's mock sockets, which are not real leaks.
  forceExit: true,
}
