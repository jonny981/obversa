import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The README and the contributor guide are read on the repository page, where
 * a relative link is followed as a path in the tree. A site redirect does
 * nothing for those readers, so a page that moves breaks them silently: the
 * documentation site still builds, and a check that bans retired word forms
 * sees nothing wrong with a path that is simply gone.
 */
const FILES = ['README.md', 'AGENTS.md'];

const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const HTML_SRC = /(?:src|srcset)="([^"]+)"/g;

function isRepoRelative(target) {
  if (!target) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false;   // a URL, someone else's to keep alive
  if (target.startsWith('#')) return false;                 // a heading on the same page
  if (target.startsWith('/')) return false;                 // site-absolute, not a path in the tree
  return true;
}

function targets(text) {
  const found = [];
  for (const match of text.matchAll(LINK)) found.push(match[1]);
  for (const match of text.matchAll(HTML_SRC)) found.push(match[1]);
  return found;
}

export function checkRepoLinks(root) {
  const tracked = new Set(
    execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean),
  );
  // A link to a directory is a real link on the repository page, so every
  // directory that holds a tracked file counts as a destination.
  const directories = new Set();
  for (const path of tracked) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i += 1) directories.add(parts.slice(0, i).join('/'));
  }
  const failures = [];
  for (const file of FILES) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const target of targets(text)) {
      if (!isRepoRelative(target)) continue;
      const path = target.split('#')[0];
      if (!path) continue;
      const isDirectory = directories.has(path.replace(/\/$/, ''));
      if (!tracked.has(path) && !isDirectory) {
        failures.push(`${file} links to ${path}, which is not a file or directory in this repository`);
      }
    }
  }
  return failures;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const failures = checkRepoLinks(process.cwd());
    if (failures.length) {
      for (const failure of failures) console.error(failure);
      process.exitCode = 1;
    } else {
      console.log(`Every repository-relative link in ${FILES.join(' and ')} points at a file that is here.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
