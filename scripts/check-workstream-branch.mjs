import { spawnSync } from 'node:child_process';

const branch = git('branch', '--show-current').trim();

if (branch.length === 0) {
  console.error('ERROR: commits require a named feature branch');
  process.exit(1);
}

if (branch === 'main' || branch === 'master') {
  console.error(`ERROR: ${branch} is integration-only; commit from a feature worktree`);
  process.exit(1);
}

console.log(`Feature branch policy passed for ${branch}.`);

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout;
}
