import { spawnSync } from 'node:child_process';

const agentsMode = trackedMode('AGENTS.md');
const claudeMode = trackedMode('CLAUDE.md');
const failures = [];

if (agentsMode !== '100644') failures.push('AGENTS.md must be a tracked regular file');
if (claudeMode !== '120000') {
  failures.push('CLAUDE.md must be a tracked symlink to AGENTS.md');
} else if (git('show', ':CLAUDE.md').trim() !== 'AGENTS.md') {
  failures.push('CLAUDE.md must point to AGENTS.md');
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`ERROR: ${failure}`);
  process.exit(1);
}

console.log('Agent instruction links are valid.');

function trackedMode(path) {
  return git('ls-files', '-s', '--', path).trim().split(/\s+/, 1)[0] ?? '';
}

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout;
}
