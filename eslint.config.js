const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'logs/**', 'uploads/**', 'coverage/**', 'vendor/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-prototype-builtins': 'off',
      'require-atomic-updates': 'off',
      // stylistic baseline noise: warn only
      'no-empty': 'warn',
      'no-control-regex': 'warn',
      'no-useless-escape': 'warn',
      'no-irregular-whitespace': 'warn',
    },
  },
  {
    files: ['__tests__/**/*.js', 'Test/**/*.js', '**/*.test.js'],
    languageOptions: { globals: { ...globals.jest } },
  },
];
