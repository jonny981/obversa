import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A spec that no script runs is a test suite that cannot fail. It reads as
 * cover, it passes review, and it is never executed. This check fails when a
 * spec file under scripts/ is not named by any script in the root manifest,
 * so wiring a new spec in is not something a person has to remember.
 */
export function checkSpecCoverage(root) {
  const tracked = execFileSync('git', ['ls-files', 'scripts'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((path) => path.endsWith('.spec.mjs'));
  const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};
  const commands = Object.values(scripts).join(' \n ');
  const failures = [];
  for (const path of tracked) {
    if (!commands.includes(path)) failures.push(`${path} is run by no script in package.json, so it never runs`);
  }
  return failures;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const failures = checkSpecCoverage(process.cwd());
    if (failures.length) {
      for (const failure of failures) console.error(failure);
      process.exitCode = 1;
    } else {
      console.log('Every spec under scripts/ is named by a script that runs it.');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
