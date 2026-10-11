import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
