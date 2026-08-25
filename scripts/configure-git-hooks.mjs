#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function git(args, expected = [0], cwd = process.cwd()) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (!expected.includes(result.status)) {
    throw new Error(
      (result.stderr || result.stdout || `git ${args.join(' ')} failed.`).trim(),
    );
  }
  return result;
}

export function configureGitHooks(cwd = process.cwd()) {
  const probe = git(['rev-parse', '--is-inside-work-tree'], [0, 128], cwd);

  if (probe.status !== 0 || probe.stdout.trim() !== 'true') return false;

  git(['config', '--local', 'extensions.worktreeConfig', 'true'], [0], cwd);

  const shared = git(['config', '--local', '--get-all', 'core.hooksPath'], [0, 1], cwd);
  const sharedValues = shared.stdout.split(/\r?\n/).filter(Boolean);
  if (sharedValues.includes('.githooks')) {
    git([
      'config',
      '--local',
      '--fixed-value',
      '--unset-all',
      'core.hooksPath',
      '.githooks',
    ], [0], cwd);
  }

  git(['config', '--worktree', 'core.hooksPath', '.githooks'], [0], cwd);
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  configureGitHooks();
}
