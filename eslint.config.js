/**
 * Copyright (c) 2026 tbaur
 *
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file for full license text
 *
 * ESLint configuration for homebridge-myalarmcom.
 * Uses ESLint 9 flat config format.
 */
const globals = require('globals')
const tsParser = require('@typescript-eslint/parser')
const tsPlugin = require('@typescript-eslint/eslint-plugin')

module.exports = [
  {
    // Global ignores
    ignores: [
      'node_modules/**',
      'coverage/**',
      'dist/**',
      'probe-output/**',
      '*.config.js', // Don't lint config files
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
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-redeclare': 'error',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-throw-literal': 'error',
      'no-return-await': 'error',
      'no-console': 'off',
      'curly': ['error', 'all'],
      'max-depth': ['warn', 4],
      'max-params': ['warn', 5],
      'semi': ['error', 'never'],
      'quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
      'comma-dangle': ['error', 'always-multiline'],
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
    // TypeScript files
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parser: tsParser,
      parserOptions: {
        project: null, // Don't require tsconfig for basic linting
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
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-var': 'error',
      'prefer-const': 'error',
      'curly': ['error', 'all'],
      'semi': ['error', 'never'],
      'quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
      'comma-dangle': ['error', 'always-multiline'],
    },
  },
]
