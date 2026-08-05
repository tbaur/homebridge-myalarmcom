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
      // Production strictness with `noUnusedLocals` and `noUnusedParameters`
      // relaxed, so an arranged-but-unused fixture is not a compile error.
      tsconfig: 'tsconfig.test.json',
    }],
  },

  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],

  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,

  // Serial. Several suites drive module-level singletons (the `ws` mock's
  // instance list, nock's interceptor registry) and the integration suites wait
  // out real intervals, so parallel workers interleave into flakes.
  maxWorkers: 1,

  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  // Set just below the current numbers rather than at a round 80: a threshold
  // far under actual coverage cannot notice a regression. A per-file floor for
  // platform.ts as well, since a global-only gate lets the largest and most
  // lifecycle-heavy file rot while the aggregate holds.
  coverageThreshold: {
    global: {
      branches: 87,
      functions: 93,
      lines: 95,
      statements: 95,
    },
    // A ratchet set just under the current figures, not an aspiration. What is
    // still uncovered is the disabled-config construction path and a handful of
    // one-line collaborator callbacks; the ones that carry a message a user would
    // see — the keep-alive tick and the stream-unavailable warning — are covered
    // by tests/unit/platform.callbacks.test.ts. Raise these as that improves;
    // never lower them to make a change pass.
    './src/platform.ts': {
      branches: 82,
      functions: 80,
      lines: 90,
      statements: 90,
    },
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    // Entry point only. `src/errors/index.ts` is the error hierarchy, not a
    // barrel, and must stay counted.
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
  // for nock 14's mock sockets, which are not real leaks. Timer cleanup is
  // asserted directly instead — see the platform shutdown tests — so forceExit
  // is not standing in for that.
  forceExit: true,
}
