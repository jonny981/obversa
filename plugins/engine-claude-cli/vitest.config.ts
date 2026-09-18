import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@obversa/api/testing',
        replacement: fileURLToPath(
          new URL('../../packages/api/src/testing.ts', import.meta.url),
        ),
      },
      {
        find: '@obversa/core/command',
        replacement: fileURLToPath(
          new URL('../../packages/core/src/command/run.ts', import.meta.url),
        ),
      },
      {
        find: '@obversa/api',
        replacement: fileURLToPath(
          new URL('../../packages/api/src/index.ts', import.meta.url),
        ),
      },
    ],
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
});
