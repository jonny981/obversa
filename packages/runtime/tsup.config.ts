import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    api: 'src/api.ts',
    testing: 'src/testing.ts',
    memory: 'src/memory.ts',
    'workflow-support': 'src/workflow-support.ts',
    'env/command': 'src/env/command.ts',
    'storage/local': 'src/storage/local.ts',
    'bin/record': 'src/bin/record.ts',
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
