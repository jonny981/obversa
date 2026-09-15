#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function checkExampleOutput(result, label) {
  const stdout = result.stdout ?? '';
  if (result.status === 0 && result.signal === null && stdout.trim() === '') {
    throw new Error(`${label} exited 0 without printing an outcome`);
  }
  if (result.status === 0 && result.signal === null) {
    try {
      JSON.parse(stdout);
    } catch {
      throw new Error(`${label} exited 0 but did not print a JSON outcome`);
    }
  }
  return `${stdout}${result.stderr ?? ''}`;
}

if (process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error('usage: check-example-output.mjs <command> [args...]');

  const result = spawnSync(command, args, { encoding: 'utf8' });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  let valid = true;
  try {
    checkExampleOutput(result, [command, ...args].join(' '));
  } catch (error) {
    valid = false;
    console.error(error instanceof Error ? error.message : String(error));
  }
  if (!valid || result.error !== undefined) process.exitCode = 1;
  else if (result.status !== null) process.exitCode = result.status;
}
