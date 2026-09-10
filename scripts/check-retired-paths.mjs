import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * The retired forms the D23 rename moved are banned from every tracked
 * file. The docs.json redirect entries are the one allowlisted place,
 * because a redirect names the path it moves a reader from.
 */
const BANNED = [
  { name: 'retired directory name', pattern: /production-lines/ },
  { name: 'retired example suffix (ts)', pattern: /\.line\.ts/ },
  { name: 'retired example suffix (js)', pattern: /\.line\.js/ },
  { name: 'retired heading', pattern: /## Run the line\b/ },
];

const ALLOW = /^(docs\/public\/docs\.json|CHANGELOG\.md)$/;

function trackedFiles(root) {
  const output = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  return output.split('\n').filter(Boolean);
}

export function checkRetiredPaths(root) {
  const failures = [];
  for (const file of trackedFiles(root)) {
    if (ALLOW.test(file)) continue;
    let text;
    try {
      text = execFileSync('git', ['show', `HEAD:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    } catch {
      continue;
    }
    for (const rule of BANNED) {
      if (rule.pattern.test(text)) {
        failures.push(`${file}: contains the ${rule.name}`);
      }
    }
  }
  return failures;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const root = process.cwd();
    const failures = checkRetiredPaths(root);
    if (failures.length) {
      for (const failure of failures) console.error(failure);
      process.exitCode = 1;
    } else {
      console.log('No retired rename form appears in any tracked file outside the redirects.');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
