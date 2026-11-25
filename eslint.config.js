// ESLint: correctness rules only (formatting is Prettier's job). Run with `npm run lint`.
import js from '@eslint/js';
import vue from 'eslint-plugin-vue';
import globals from 'globals';

export default [
  { ignores: ['dist/**', 'node_modules/**', '.claude/**', 'public/**'] },
  js.configs.recommended,
  ...vue.configs['flat/essential'],
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-assignment': 'off', // flags the `let x = null; try { x = ... }` pattern used across the code
      'vue/multi-word-component-names': 'off', // Modal, Avatar, Skeleton... are established names
      // Child panels edit a reactive form object the parent owns (ReportSource, WorkspaceFonts). Kept visible, not fatal.
      'vue/no-mutating-props': 'warn',
    },
  },
  { files: ['src/**'], languageOptions: { globals: { ...globals.browser, __APP_VERSION__: 'readonly' } } },
  { files: ['server/**', 'scripts/**', 'test/**', '*.js'], languageOptions: { globals: { ...globals.node, ...globals.serviceworker } } },
  { files: ['test/**'], languageOptions: { globals: { ...globals.browser } }, rules: { 'vue/no-reserved-component-names': 'off' } },
];
