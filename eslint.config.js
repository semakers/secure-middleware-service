import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import regexp from 'eslint-plugin-regexp';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  regexp.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // ReDoS guards: fail the lint on any regex with super-linear backtracking.
      'regexp/no-super-linear-backtracking': 'error',
      'regexp/no-super-linear-move': 'error',
      'no-console': 'error',
    },
  },
  {
    files: ['scripts/**', 'tests/**'],
    rules: { 'no-console': 'off' },
  },
);
