import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@obversa/engine',
        replacement: fileURLToPath(
          new URL('../../packages/engine/src/index.ts', import.meta.url),
        ),
      },
      {
        find: '@obversa/memory',
        replacement: fileURLToPath(
          new URL('../../packages/memory/src/index.ts', import.meta.url),
        ),
      },
    ],
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
});
