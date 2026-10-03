// Runs one isolated step that writes into its worktree, tells the parent
// test where that worktree is, then waits forever so the test can kill it.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { run, isolated, fnJob } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';

const repo = process.argv[2]!;

await run(isolated(fnJob('build', async (ctx) => {
  writeFileSync(join(ctx.workspace.dir, 'out.txt'), 'half done\n');
  process.send!(ctx.workspace.dir);
  return await new Promise(() => {});
}), { label: 'build' }), {
  engine: 'mock',
  engines: { mock: new MockEngine(() => '') },
  cwd: repo,
});
