import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@obversa/engine/command',
        replacement: fileURLToPath(
          new URL('../../packages/engine/src/command/run.ts', import.meta.url),
        ),
      },
      {
        find: '@obversa/engine/testing',
        replacement: fileURLToPath(
          new URL('../../packages/engine/src/testing.ts', import.meta.url),
        ),
      },
      {
        find: '@obversa/engine',
        replacement: fileURLToPath(
          new URL('../../packages/engine/src/index.ts', import.meta.url),
        ),
      },
    ],
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
});
