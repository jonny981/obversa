// The direct-loader-form bans and name resolution through exports maps
// (an internal note).
//
// dependency-cruiser owns the package-arrow rules; ESLint bans the forms that
// reach the module loader or the process without an import statement, and
// proves every named import resolves through the TypeScript resolver, which
// reads exports maps. Expression-built forms — aliases through variables,
// reflection, indirect eval — stay out of scope and are stated as residuals
// in The fixture matrix in scripts/check-lint.spec.mjs asserts each
// banned form is reported.
//
// Scope: the JavaScript files. The TypeScript packages keep the boundary
// scanner's loader-hatch rule until workstream 1's tsconfig migration lands a
// TypeScript parser story — typescript-eslint refuses the root's TS 7 pin.
//
// eslint-plugin-import is never installed beside eslint-plugin-import-x.

import { createRequire } from 'node:module';

import { flatConfigs as importX } from 'eslint-plugin-import-x';

const require = createRequire(import.meta.url);

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'docs/**',
      // The browser page imports ./surface-client.mjs as a URL the surfacer
      // serves at runtime; no file exists beside the page source.
      'packages/source/assets/app.js',
    ],
  },
  {
    files: ['**/*.mjs', '**/*.cjs', '**/*.js'],
    ...importX.recommended,
    rules: {
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-properties': [
        'error',
        { property: 'getBuiltinModule', message: 'reaches a builtin without an import statement' },
        { object: 'module', property: 'constructor', message: 'reaches the module loader' },
        { object: 'process', property: 'binding', message: 'reaches native bindings' },
        { object: 'process', property: 'dlopen', message: 'loads native code' },
        { object: 'process', property: 'mainModule', message: 'reaches the entry module graph' },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'vm', message: 'runs generated code' },
            { name: 'node:vm', message: 'runs generated code' },
          ],
        },
      ],
      'import-x/no-unresolved': ['error', { commonjs: true }],
    },
    settings: {
      'import-x/resolver-next': [
        require('eslint-import-resolver-typescript').createTypeScriptImportResolver(),
      ],
    },
  },
];
