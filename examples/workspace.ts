import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGitWorktreeProvider } from '@obversa/runtime';

const runGit = promisify(execFile);

const root = await mkdtemp(join(tmpdir(), 'obversa-workspace-example-'));
const directory = join(root, 'repository');
try {
  await mkdir(directory);
  await runGit('git', ['init', '-q', '-b', 'main'], { cwd: directory });
  await writeFile(join(directory, 'README.md'), '# workspace\n');
  await runGit('git', ['add', 'README.md'], { cwd: directory });
  await runGit('git', ['-c', 'user.name=Example', '-c', 'user.email=example@example.com', 'commit', '-qm', 'initial'], { cwd: directory });
  const workspace = createGitWorktreeProvider({ repositoryPath: directory });
  const anchor = await workspace.capture();
  const verified = await workspace.verify(anchor);
  if (!verified.ok) throw new Error('workspace changed before fork');
  const lease = await workspace.acquireLease('example', 'workspace-example', anchor);
  if (!lease.ok) throw new Error('lease was not acquired');
  const fork = await workspace.fork(anchor, 'example-child', lease.token);
  await workspace.releaseLease(lease.token);
  if (!fork.ok) throw new Error(`fork failed: ${fork.kind}`);
  const childHead = (await runGit('git', ['rev-parse', 'HEAD'], { cwd: fork.worktreePath })).stdout.trim();
  if (childHead !== anchor.head) throw new Error('child worktree has the wrong revision');
  if (await readFile(join(fork.worktreePath, 'README.md'), 'utf8') !== '# workspace\n') {
    throw new Error('child worktree has the wrong contents');
  }
  const report = { revision: childHead, anchor: lease.anchorDigest, branch: fork.branchRef };
  console.log(JSON.stringify(report));
} finally {
  await rm(root, { recursive: true, force: true });
}
