// Configuración compartida de ESLint (flat config) para todo el monorepo.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import { forbiddenDomSyntax, securityPlugin } from './tools/eslint/security-plugin.mjs';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'apps/api/drizzle/**',
      'apps/web/.angular/**',
      'apps/web/test-results/**',
      'apps/web/playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['**/scripts/**', '**/test/**', 'tools/**'],
    rules: { 'no-console': 'off' },
  },

  // Panel (Angular): TypeScript de la app, con globals de navegador y las reglas de seguridad.
  {
    files: ['apps/web/src/**/*.ts'],
    extends: [...angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'app', style: 'kebab-case' },
      ],
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'app', style: 'camelCase' },
      ],
      'no-restricted-syntax': ['error', ...forbiddenDomSyntax],
    },
  },
  // Plantillas (inline y .html): accesibilidad y sin [innerHTML].
  {
    files: ['apps/web/src/**/*.html'],
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
    plugins: { security: securityPlugin },
    rules: { 'security/no-inner-html-binding': 'error' },
  },
  {
    files: ['apps/web/e2e/**/*.ts', 'apps/web/playwright.config.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-console': 'off' },
  },
  prettier,
);
