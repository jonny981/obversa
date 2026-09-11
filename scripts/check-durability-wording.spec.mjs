import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { checkDurabilityWording } from './check-durability-wording.mjs';

/**
 * The claim this check guards is the one a reader is most likely to act on
 * and most likely to get wrong, so the arms here prove the check can tell
 * three states apart: the same words, different words, and no claim at all.
 */
const CORE = 'Steps that finished are never repeated. A step that was mid-flight when the worker died runs again only if its binding declares it safe to retry; otherwise the run pauses and asks a person to reconcile it before it continues, so uncertain work is never repeated silently.';

function treeWith(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'durability-'));
  const files = {
    'README.md': `Some opening prose.\n\n${CORE}\n`,
    'AGENTS.md': `A guide.\n\n${CORE}\n`,
    'docs/public/recording/how-a-run-is-recorded.mdx': `---\ntitle: "x"\n---\n\n${CORE}\n`,
    ...overrides,
  };
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

function run(overrides, assertions) {
  const dir = treeWith(overrides);
  try { assertions(checkDurabilityWording(dir)); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the same words in all three files pass', () => {
  run({}, (failures) => assert.deepEqual(failures, []));
});

test('line wrapping is not a difference', () => {
  run({ 'AGENTS.md': `A guide.\n\n${CORE.replace(/ /g, (m, i) => (i % 40 === 0 ? '\n' : m))}\n` },
    (failures) => assert.deepEqual(failures, []));
});

test('a reworded ending is reported as different words, not as missing', () => {
  run({ 'AGENTS.md': `A guide.\n\n${CORE.replace('never repeated silently.', 'never repeated twice.')}\n` },
    (failures) => {
      assert.equal(failures.length, 1, failures.join('; '));
      assert.match(failures[0], /contributor guide states the durability rule in different words/);
    });
});

test('a file that drops the claim is reported as missing it', () => {
  run({ 'AGENTS.md': 'A guide with nothing about crashes.\n' }, (failures) => {
    assert.equal(failures.length, 1, failures.join('; '));
    assert.match(failures[0], /contributor guide does not carry the durability sentences/);
  });
});

test('each of the three files is checked, not just the first', () => {
  for (const [file, name] of [['README.md', /README/], ['AGENTS.md', /contributor guide/], ['docs/public/recording/how-a-run-is-recorded.mdx', /record page/]]) {
    run({ [file]: 'nothing here\n' }, (failures) => {
      assert.equal(failures.length, 1, `${file}: ${failures.join('; ')}`);
      assert.match(failures[0], name);
    });
  }
});
