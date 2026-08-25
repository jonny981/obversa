import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    api: 'src/api.ts',
    testing: 'src/testing.ts',
    'env/command': 'src/env/command.ts',
  },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  dts: false,
  splitting: true,
  sourcemap: true,
  clean: true,
  shims: false,
  treeshake: true,
});
