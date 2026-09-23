#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { recordWorkspaceBuild } from './check-publish-allowlist.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('pnpm build must run through pnpm');

recordWorkspaceBuild({
  root,
  runBuild() {
    execFileSync(process.execPath, [pnpm, '--recursive', '--if-present', 'run', 'build'], {
      cwd: root,
      stdio: 'inherit',
    });
  },
});
