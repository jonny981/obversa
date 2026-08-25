#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

function git(args, expected = [0]) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (!expected.includes(result.status)) {
    throw new Error(
      (result.stderr || result.stdout || `git ${args.join(' ')} failed.`).trim(),
    );
  }
  return result;
}

const probe = git(['rev-parse', '--is-inside-work-tree'], [0, 128]);

if (probe.status === 0 && probe.stdout.trim() === 'true') {
  git(['config', '--local', 'extensions.worktreeConfig', 'true']);

  const shared = git(['config', '--local', '--get-all', 'core.hooksPath'], [0, 1]);
  const sharedValues = shared.stdout.split(/\r?\n/).filter(Boolean);
  if (sharedValues.includes('.githooks')) {
    git([
      'config',
      '--local',
      '--fixed-value',
      '--unset-all',
      'core.hooksPath',
      '.githooks',
    ]);
  }

  git(['config', '--worktree', 'core.hooksPath', '.githooks']);
}
