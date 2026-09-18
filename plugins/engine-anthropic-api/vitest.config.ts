import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
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
