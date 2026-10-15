import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// The root starts a detached helper that holds 160 MB and does not keep the
// command's pipes, stays alive for 400 ms so the attempt's monitor samples
// the helper into its observed list while the helper's parent link is still
// alive, records the helper's process id, and exits.
const [barrierDir] = process.argv.slice(2);

const helper = spawn(
  process.execPath,
  ['-e', 'globalThis.held = Buffer.alloc(160 * 1024 * 1024, 0x78); setInterval(() => {}, 1000);'],
  { detached: true, stdio: 'ignore' },
);
helper.unref();
const barrier = join(barrierDir, 'leftover.json');
writeFileSync(`${barrier}.tmp`, JSON.stringify({ pid: helper.pid }));
renameSync(`${barrier}.tmp`, barrier);
setTimeout(() => process.exit(0), 400);
