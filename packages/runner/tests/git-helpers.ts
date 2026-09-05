import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const git = promisify(execFile);
const created: string[] = [];

/** A disposable real Git repository with a configured author. */
export async function tmpRepo(
  opts: { initialCommit?: boolean } = {},
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'obversa-runner-git-'));
  created.push(dir);
  await git('git', ['init', '-b', 'main'], { cwd: dir });
  await git('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await git('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  await git('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  if (opts.initialCommit ?? true) {
    writeFileSync(join(dir, 'README.md'), '# test\n');
    await git('git', ['add', '-A'], { cwd: dir });
    await git('git', ['commit', '-m', 'chore: init'], { cwd: dir });
  }
  return dir;
}

export function cleanupRepos(): void {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup, matching the runtime test fixtures.
    }
  }
}
