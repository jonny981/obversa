import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const RUN_DIR = '.lines';

/** Create one safe runtime-owned directory under the workspace. */
export function ensureRunSubdir(workspaceDir: string, name: string): string {
  const root = resolve(workspaceDir);
  const runDir = join(root, RUN_DIR);
  assertSafeDirectory(root, runDir, RUN_DIR);
  mkdirSync(runDir, { recursive: true });
  assertSafeDirectory(root, runDir, RUN_DIR);

  const dir = join(runDir, name);
  assertSafeDirectory(root, dir, `${RUN_DIR}/${name}`);
  mkdirSync(dir, { recursive: true });
  assertSafeDirectory(root, dir, `${RUN_DIR}/${name}`);

  const ignore = join(runDir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
  return dir;
}

function assertSafeDirectory(root: string, dir: string, label: string): void {
  if (!existsSync(dir)) return;
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`unsafe ${label}: expected a real workspace directory`);
  }
  const rel = relative(realpathSync(root), realpathSync(dir));
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`unsafe ${label}: resolves outside the workspace`);
  }
}
