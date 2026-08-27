import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const [barrierDir] = process.argv.slice(2);
mkdirSync(barrierDir, { recursive: true });

const child = spawn(
  process.execPath,
  [join(import.meta.dirname, 'detached-grandchild.mjs'), 'ignore', barrierDir],
  {
    detached: true,
    env: process.env,
    stdio: 'inherit',
  },
);
child.unref();
const barrier = join(barrierDir, 'direct.json');
writeFileSync(`${barrier}.tmp`, JSON.stringify({ pid: child.pid }));
renameSync(`${barrier}.tmp`, barrier);
process.stdout.write('PONG');
