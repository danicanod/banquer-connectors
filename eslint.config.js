import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      // Unused variables - error level
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Discourage `any` - warn to allow intentional use
      '@typescript-eslint/no-explicit-any': 'warn',

      // No console outside approved files
      'no-console': [
        'error',
        {
          allow: ['warn', 'error'],
        },
      ],

      // Naming conventions - discourage ALL_CAPS for non-const identifiers
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          selector: 'variable',
          modifiers: ['const'],
          format: ['camelCase', 'PascalCase', 'UPPER_CASE'],
        },
        {
          selector: 'variable',
          format: ['camelCase', 'PascalCase'],
        },
        {
          selector: 'function',
          format: ['camelCase', 'PascalCase'],
        },
        {
          selector: 'parameter',
          format: ['camelCase'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
        {
          selector: 'enumMember',
          format: ['PascalCase', 'UPPER_CASE'],
        },
      ],

      // Prefer const
      'prefer-const': 'error',

      // No var
      'no-var': 'error',
    },
  },
  {
    // Allow console in logger utilities, auth flows, examples, and client files
    files: [
      '**/network-logger.ts',
      '**/debug-logger.ts',
      '**/base-bank-auth.ts',
      '**/security-questions.ts',
      '**/banesco-auth.ts',
      '**/http-client.ts',
      '**/examples/**',
      '**/*-http-client.ts',
      '**/client.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Ignore generated files and dist
    ignores: ['dist/**', 'node_modules/**'],
  }
);
