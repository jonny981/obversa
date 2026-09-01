/** Temp git repos for the substrate tests — real git, offline, deterministic. */
import { execa } from 'execa';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];

/** A fresh git repo on `main` with a configured author and an initial commit. */
export async function tmpRepo(
  opts: { initialCommit?: boolean } = {},
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'lines-git-'));
  created.push(dir);
  await execa('git', ['init', '-b', 'main'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  if (opts.initialCommit ?? true) {
    writeFileSync(join(dir, 'README.md'), '# test\n');
    await execa('git', ['add', '-A'], { cwd: dir });
    await execa('git', ['commit', '-m', 'chore: init'], { cwd: dir });
  }
  return dir;
}

/** A temp directory that is NOT a git repo. */
export function tmpBareDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lines-nogit-'));
  created.push(dir);
  return dir;
}

export function write(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

/** Remove every temp dir created in this test file. */
export function cleanupRepos(): void {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}
