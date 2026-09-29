// Flat config for the monorepo.
// Package-specific overrides live in each package's eslint.config.js.
import eslint from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';
import eslintPluginPrettier from 'eslint-plugin-prettier';
import eslintConfigPrettier from 'eslint-config-prettier';
import markdown from '@eslint/markdown';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toFlatConfigArray = (config) => (Array.isArray(config) ? config : [config]);

export default [
  eslint.configs.recommended,
  ...toFlatConfigArray(tseslint.configs.strict),
  ...toFlatConfigArray(tseslint.configs.stylistic),
  ...tsPlugin.configs['flat/strict'],
  {
    files: ['**/*.{ts,js}'],
    plugins: {
      '@stylistic': stylistic,
      prettier: eslintPluginPrettier,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      'prettier/prettier': 'warn',
      '@stylistic/array-bracket-newline': ['error', 'consistent'],
      '@stylistic/array-bracket-spacing': 'error',
      '@stylistic/array-element-newline': ['error', 'consistent'],
      '@stylistic/arrow-parens': 'error',
      '@stylistic/arrow-spacing': 'error',
      '@stylistic/block-spacing': 'error',
      '@stylistic/brace-style': 'error',
      '@stylistic/comma-dangle': ['error', 'always-multiline'],
      '@stylistic/comma-spacing': 'error',
      '@stylistic/comma-style': 'error',
      '@stylistic/computed-property-spacing': 'error',
      '@stylistic/curly-newline': ['error', { consistent: true }],
      '@stylistic/eol-last': 'error',
      '@stylistic/function-call-argument-newline': ['error', 'consistent'],
      '@stylistic/function-call-spacing': 'error',
      '@stylistic/function-paren-newline': ['error', 'multiline-arguments'],
      '@stylistic/implicit-arrow-linebreak': 'error',
      '@stylistic/indent': ['error', 2],
      '@stylistic/indent-binary-ops': ['error', 2],
      '@stylistic/key-spacing': ['error', { beforeColon: false, afterColon: true, mode: 'strict' }],
      '@stylistic/keyword-spacing': 'error',
      '@stylistic/lines-between-class-members': [
        'error',
        {
          enforce: [
            { blankLine: 'never', prev: 'field', next: 'field' },
            { blankLine: 'always', prev: '*', next: 'method' },
          ],
        },
        { exceptAfterOverload: true },
      ],
      '@stylistic/max-len': ['error', { code: 120, ignoreTrailingComments: true, ignoreUrls: true }],
      '@stylistic/max-statements-per-line': 'error',
      '@stylistic/member-delimiter-style': 'error',
      '@stylistic/new-parens': 'error',
      // '@stylistic/newline-per-chained-call': ['error', { ignoreChainWithDepth: 2 }],
      '@stylistic/no-extra-parens': 'error',
      '@stylistic/no-extra-semi': 'error',
      '@stylistic/no-floating-decimal': 'error',
      '@stylistic/no-mixed-operators': 'error',
      '@stylistic/no-multi-spaces': 'error',
      '@stylistic/no-multiple-empty-lines': ['error', { max: 1, maxEOF: 0 }],
      '@stylistic/no-tabs': 'error',
      '@stylistic/no-trailing-spaces': 'error',
      '@stylistic/no-whitespace-before-property': 'error',
      '@stylistic/nonblock-statement-body-position': ['error', 'beside'],
      '@stylistic/object-curly-newline': ['error', { multiline: true, consistent: true }],
      '@stylistic/object-curly-spacing': ['error', 'always'],
      '@stylistic/one-var-declaration-per-line': 'error',
      '@stylistic/operator-linebreak': ['error', 'after'],
      '@stylistic/padded-blocks': ['error', 'never'],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: ['const', 'let'], next: '*' },
        { blankLine: 'always', prev: '*', next: ['const', 'let'] },
        { blankLine: 'any', prev: ['const', 'let'], next: ['const', 'let'] },
        { blankLine: 'always', prev: ['case', 'default'], next: '*' },
        {
          blankLine: 'never',
          prev: ['const', 'let'],
          next: ['const', 'let'],
        },
      ],
      '@stylistic/quote-props': ['error', 'as-needed'],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: 'always' }],
      '@stylistic/rest-spread-spacing': 'error',
      '@stylistic/semi': 'error',
      '@stylistic/semi-spacing': 'error',
      '@stylistic/semi-style': 'error',
      '@stylistic/space-before-blocks': 'error',
      '@stylistic/space-before-function-paren': [
        'error',
        {
          anonymous: 'always',
          asyncArrow: 'always',
          catch: 'always',
          named: 'never',
        },
      ],
      '@stylistic/space-in-parens': 'error',
      '@stylistic/space-infix-ops': 'error',
      '@stylistic/space-unary-ops': ['error', { words: true, nonwords: false }],
      '@stylistic/spaced-comment': 'error',
      '@stylistic/switch-colon-spacing': 'error',
      '@stylistic/template-curly-spacing': 'error',
      '@stylistic/type-annotation-spacing': 'error',
      '@stylistic/type-generic-spacing': 'error',
      '@stylistic/type-named-tuple-spacing': 'error',
      '@stylistic/wrap-iife': [2, 'inside', { functionPrototypeMethods: true }],
      '@stylistic/wrap-regex': 'error',
      '@typescript-eslint/no-extraneous-class': [
        'error',
        { allowConstructorOnly: true, allowEmpty: true, allowWithDecorator: true },
      ],
      curly: 'error',
      'one-var': ['error', 'never'],
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'no-lonely-if': 'error',
      'no-nested-ternary': 'warn',
      'no-param-reassign': 'error',
      'no-unneeded-ternary': 'error',
      'no-var': 'error',
      'prefer-arrow-callback': 'error',
      'prefer-const': 'error',
    },
  },
  // Markdown: use @eslint/markdown parser, run only Prettier formatting check.
  {
    files: ['**/*.md'],
    plugins: {
      markdown,
      prettier: eslintPluginPrettier,
    },
    language: 'markdown/gfm',
    rules: {
      'prettier/prettier': ['warn', { parser: 'markdown' }],
      // Disable markdown-specific rules from @eslint/markdown
      'markdown/fenced-code-language': 'off',
      'markdown/no-missing-label-refs': 'off',
      // Core JS rules incompatible with the markdown parser
      'no-irregular-whitespace': 'off',
      'no-unused-vars': 'off',
    },
  },
  // Cloudflare Pages Functions (ui/public/functions/, deployed as-is) run in the
  // Workers runtime — declare its globals so no-undef passes for plain .js files.
  {
    files: ['**/public/functions/**/*.js'],
    languageOptions: {
      globals: {
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
      },
    },
  },
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/coverage/',
      '**/.angular/',
      '**/.wrangler/',
      // LEGACY in-repository worktree location: the runtime creates worktrees OUTSIDE the repository, so nothing
      // writes this path. Kept because an orphan left there is another checkout of the source tree, and linting it
      // would walk it on every run.
      '.harness/state/worktrees/',
      // Harness prose is validated by the harness itself (`.harness/tests/`), not by the application linter: the
      // `docs/` entry below covers only the application docs, so without these the `**/*.md` block above walks
      // harness documentation on every run. Markdown-scoped; the harness `.mjs` fixtures stay covered by
      // `**/*.mjs`, unchanged. No apostrophes in this comment: the self-test reads this array as quoted source.
      '.harness/**/*.md',
      // The harness-evaluator capability file loads for the harness-evaluator mode alone, and is the same layer.
      '.roo/rules-harness-evaluator/**/*.md',
      // Agent scratch is throwaway and disposable: linting it wastes wall clock on every run and can hang on a
      // generated file, for content nobody will ever commit.
      '.agent-scratch/',
      'docs/',
      '**/*.mjs',
      '**/*.cjs',
      '**/libs/**/*.ts',
    ],
  },
  // Disables all @stylistic rules that conflict with Prettier.
  // Must be last so Prettier is the formatting authority; ESLint keeps code-quality rules.
  eslintConfigPrettier,
];
