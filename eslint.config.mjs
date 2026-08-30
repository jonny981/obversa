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
  // The browser page's import of ./surface-client.mjs — served over HTTP at
  // runtime — resolves through the declaration file beside the page, so the
  // page is linted in full: every ban applies to it like any other file.
  {
    ignores: ['**/node_modules/**', '**/dist/**', 'docs/**'],
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
      // no-restricted-imports sees only static imports; the dynamic and
      // CommonJS spellings of the vm modules are banned by syntax.
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportExpression > Literal[value='vm'], ImportExpression > Literal[value='node:vm']",
          message: 'runs generated code',
        },
        {
          selector: "CallExpression[callee.name='require'] > Literal[value='vm'], CallExpression[callee.name='require'] > Literal[value='node:vm']",
          message: 'runs generated code',
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
