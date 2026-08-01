import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**']
  },
  js.configs.recommended,
  {
    // The TypeScript rule set must not leak onto the CommonJS test suite,
    // which require()s the compiled plugin on purpose.
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // The plugin reaches ESM-only wetty from CommonJS, which needs both a
      // dynamic import TypeScript will not rewrite and plain require() calls
      // for optional transitive dependencies.
      'no-new-func': 'off',
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    files: ['test/**/*.js', 'integration/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2022 }
    }
  }
)
