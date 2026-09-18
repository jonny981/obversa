import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    testing: 'src/testing.ts',
    'run-definition-support': 'src/run-definition-support.ts',
    'accepted-result-support': 'src/accepted-result-support.ts',
    'approval-support': 'src/approval-support.ts',
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
