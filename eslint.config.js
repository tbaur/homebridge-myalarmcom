/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * ESLint configuration for homebridge-myalarmcom.
 * Uses the flat config format.
 */
const globals = require('globals')
const tsParser = require('@typescript-eslint/parser')
const tsPlugin = require('@typescript-eslint/eslint-plugin')

/**
 * House rules that are language-agnostic.
 *
 * Declared once so the TypeScript block cannot drift into being *weaker* than
 * the JavaScript one — which is how `max-params`, `eqeqeq`, and
 * `no-throw-literal` ended up enforced only on the development scripts and not
 * on the plugin itself.
 */
const sharedRules = {
  'eqeqeq': ['error', 'always', { null: 'ignore' }],
  'no-var': 'error',
  'prefer-const': 'error',
  'no-throw-literal': 'error',
  'no-console': 'off',
  'curly': ['error', 'all'],
  'max-depth': ['error', 4],
  'max-params': ['error', 4],
  // The house rule is "one thing, ~50 lines". The ceiling is set at the current
  // worst case rather than the target so it ratchets down instead of demanding a
  // refactor before it can be turned on at all.
  'max-lines-per-function': ['error', { max: 80, skipComments: true, skipBlankLines: true }],
  'complexity': ['error', 12],
  'semi': ['error', 'never'],
  'quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
  'comma-dangle': ['error', 'always-multiline'],
}

module.exports = [
  {
    // Global ignores. Config files are linted; only build output is not.
    ignores: [
      'node_modules/**',
      'coverage/**',
      'dist/**',
      'probe-output/**',
    ],
  },
  {
    // JavaScript files
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      ...sharedRules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-redeclare': 'error',
      'no-return-await': 'error',
    },
  },
  {
    // ES modules under scripts/ use import syntax
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
    },
  },
  {
    // TypeScript files.
    //
    // parserOptions.project turns on the type-aware rules. Without it the
    // entire async-correctness family (no-floating-promises, no-misused-
    // promises, await-thenable) is silently unavailable — on a codebase built
    // almost entirely from timers and fire-and-forget promises.
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tsParser,
      parserOptions: {
        project: ['./tsconfig.test.json'],
        tsconfigRootDir: __dirname,
      },
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // Type-checked, not just syntactic. `parserOptions.project` below points at
      // a project that includes every source and test file, so the rules that
      // need type information actually run — which is what catches an optional
      // chain on a non-optional value, or a value typed `any` crossing a
      // boundary. Individual rules are relaxed below where the cost is not worth
      // it, each with a reason.
      ...tsPlugin.configs['recommended-type-checked'].rules,
      ...sharedRules,
      // Covered by the TypeScript compiler, and the base rules report false
      // positives on type-only syntax.
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-redeclare': 'off',
      'no-throw-literal': 'off',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      // The plugin's entire mapping layer exists to compare *unvalidated* wire
      // values against enums: Alarm.com responses are not runtime-validated, so
      // the parameters are deliberately `unknown` or `number` and the comparison
      // against the enum is the validation. Requiring a shared enum type here
      // would mean asserting the value already is one, which is the assumption
      // these functions are written to avoid making.
      '@typescript-eslint/no-unsafe-enum-comparison': 'off',
    },
  },
  {
    // Diagnostic CLIs. Their `main` narrates a fixed sequence of steps and their
    // branching is mostly "print this variant of the finding", which is what they
    // exist to do — splitting it up would scatter the narration without making
    // anything clearer. Still bounded, just calibrated to that shape, so a
    // genuinely runaway function is still caught.
    files: ['scripts/**/*.mjs'],
    rules: {
      'complexity': ['error', 26],
      'max-lines-per-function': ['error', { max: 160, skipComments: true, skipBlankLines: true }],
    },
  },
  {
    // `package.json` lives outside `rootDir`, so a static import of it would
    // change the emitted dist/ layout. The require is the point of this file
    // and is explained there; see src/utils/version.ts. The test needs the same
    // exemption to re-require the module under a mocked `package.json`, which is
    // the only way to reach the fallback path.
    files: ['src/utils/version.ts', 'tests/unit/utils/version.test.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      // Non-null assertions on values the test itself has just arranged. There
      // is no `any` in tests — the doubles use `as unknown as`, which is
      // narrower and stays covered by the rules above.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // `jest.requireActual<typeof import('...')>()` is the only way to type a
      // partial module mock, and it requires an inline import type.
      '@typescript-eslint/consistent-type-imports': 'off',
      // Test helpers take positional arrangement parameters, where an options
      // object would obscure the arrangement rather than clarify it.
      'max-params': 'off',
      // Arrangement blocks are long by nature and splitting them hides the setup
      // a reader needs in view to understand the assertion.
      'max-lines-per-function': 'off',
      // Jest's mock and spy surface is loosely typed by design, so the
      // type-checked unsafe-* family fires on ordinary, correct test code. These
      // stay enabled for `src/`, which is where they earn their keep.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // Tests assert on serialized request bodies, where the whole point is what
      // the default stringification produces.
      '@typescript-eslint/no-base-to-string': 'off',
      // One test builds a function to measure regex backtracking; that is the
      // measurement, not an injection path.
      '@typescript-eslint/no-implied-eval': 'off',
    },
  },
]
