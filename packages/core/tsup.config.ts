import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    command: 'src/command/run.ts',
    'claude-stream-json': 'src/claude-stream-json.ts',
    'claude-tools': 'src/claude-tools.ts',
    testing: 'src/testing.ts',
  },
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  dts: false,
  splitting: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
