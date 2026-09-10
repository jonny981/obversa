import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { checkRepoLinks } from './check-repo-links.mjs';

/**
 * Every arm here exists because the check has to tell three things apart: a
 * path that is gone, a path that is a directory, and a target that was never
 * a path in this tree at all. Getting the last two wrong is how a link check
 * gets switched off.
 */
function repoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'repo-links-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  for (const [name, body] of Object.entries({ 'README.md': '', 'AGENTS.md': '', ...files })) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: dir });
  return dir;
}

function run(files, assertions) {
  const dir = repoWith(files);
  try { assertions(checkRepoLinks(dir)); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a link to a file that is not here fails, and names the file that carries it', () => {
  run({ 'README.md': 'Read [the page](docs/public/gone/page.mdx) for more.\n' }, (failures) => {
    assert.equal(failures.length, 1, failures.join('; '));
    assert.match(failures[0], /^README\.md links to docs\/public\/gone\/page\.mdx/);
  });
});

test('the contributor guide is checked too', () => {
  run({ 'AGENTS.md': 'See [the plan](docs/plan.md).\n' }, (failures) => {
    assert.equal(failures.length, 1, failures.join('; '));
    assert.match(failures[0], /^AGENTS\.md links to docs\/plan\.md/);
  });
});

test('a link to a tracked file passes, with or without a heading on the end', () => {
  run({
    'README.md': 'Read [it](docs/page.mdx) and [that part](docs/page.mdx#a-heading).\n',
    'docs/page.mdx': 'x\n',
  }, (failures) => assert.deepEqual(failures, []));
});

test('a link to a directory passes, because that is a real link on the repository page', () => {
  run({
    'README.md': 'The docs are in [`docs/public`](docs/public), and in [here](docs/public/).\n',
    'docs/public/page.mdx': 'x\n',
  }, (failures) => assert.deepEqual(failures, []));
});

test('a URL, a mail address and a heading on the same page are left alone', () => {
  run({
    'README.md': [
      '[site](https://obversa.ai)',
      '[mail](mailto:someone@example.com)',
      '[same page](#a-heading)',
      '[site absolute](/get-started)',
    ].join(' ') + '\n',
  }, (failures) => assert.deepEqual(failures, []));
});

test('an image source is checked, because a moved logo shows as a broken image', () => {
  run({ 'README.md': '<img src="docs/public/logo-gone.svg" alt="Obversa">\n' }, (failures) => {
    assert.equal(failures.length, 1, failures.join('; '));
    assert.match(failures[0], /logo-gone\.svg/);
  });
});
