// Refuses a second pnpm ci:local in this worktree while the first is alive.
// Records the parent shell's pid (it runs the whole && chain, so its
// liveness is the run's); checks liveness, not cooperative cleanup, so a
// killed run's stale lock self-heals on the next attempt.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = join(root, '.obversa', 'ci-local.lock');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
if (existsSync(lockPath) && alive(Number(readFileSync(lockPath, 'utf8')))) {
  console.error(`pnpm ci:local already running in ${root} (pid ${readFileSync(lockPath, 'utf8').trim()})`);
  process.exit(1);
}
mkdirSync(dirname(lockPath), { recursive: true });
writeFileSync(lockPath, String(process.ppid));
console.log(`pnpm ci:local pid ${process.ppid} in ${root}`);
