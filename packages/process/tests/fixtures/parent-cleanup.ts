import { writeFileSync } from 'node:fs';

import { runChild } from '../../src/index.ts';

const pidPath = process.argv[2];
if (pidPath === undefined) throw new Error('pid path is required');

const result = await runChild({
  executable: process.execPath,
  args: [
    '--input-type=module',
    '-e',
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1_000);`,
  ],
  timeoutMs: 60_000,
  killGraceMs: 100,
  maxOutputBytes: 1_024,
  hooks: {
    onSpawn(child) {
      if (child.pid === undefined) throw new Error('child pid is required');
      writeFileSync(pidPath, String(child.pid));
      process.stdout.write('READY\n');
    },
  },
});

process.stdout.write(`READY ${result.exitCode ?? 'signal'}\n`);
