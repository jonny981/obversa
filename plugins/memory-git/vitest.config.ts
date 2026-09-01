import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@obversa/memory/testing',
        replacement: fileURLToPath(new URL('../../packages/memory/src/testing.ts', import.meta.url)),
      },
      {
        find: '@obversa/memory',
        replacement: fileURLToPath(new URL('../../packages/memory/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
});
