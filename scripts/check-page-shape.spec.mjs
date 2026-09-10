import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { checkPageShape, buildDebtIndex } from './check-page-shape.mjs';

const debt = (entries) => new Map(entries.map((e) => [`${e.page}::${e.fault}`, e]));

/**
 * The two rules here came from a reader's complaint about real pages: a page
 * called an example with no example on it, and pages that spend their first
 * line telling the reader the word they just read in the title.
 */
function siteWith(pages) {
  const dir = mkdtempSync(join(tmpdir(), 'page-shape-'));
  for (const [name, body] of Object.entries(pages)) {
    const path = join(dir, 'docs', 'public', name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  return dir;
}

function run(pages, assertions) {
  const dir = siteWith(pages);
  try { assertions(checkPageShape(dir)); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const page = (title, body) => `---\ntitle: "${title}"\ndescription: "d"\n---\n\n${body}`;

test('a page with a code example and a doing-first opening passes', () => {
  run({ 'a.mdx': page('Workflows', 'Write the shape once and the runtime runs it.\n\n```ts\nconst x = 1;\n```\n') },
    (failures) => assert.deepEqual(failures, []));
});

test('a page with no fenced block at all is reported', () => {
  run({ 'a.mdx': page('Workflows', 'Only prose here, for paragraphs and paragraphs.\n') }, (failures) => {
    assert.equal(failures.length, 1, failures.join('; '));
    assert.match(failures[0], /no example a reader can copy/);
  });
});

test('a page whose only block is a command is reported differently, because the fix is different', () => {
  run({ 'a.mdx': page('Workspace example', 'Run it and read the report.\n\n```bash\npnpm example:workspace\n```\n') },
    (failures) => {
      assert.equal(failures.length, 1, failures.join('; '));
      assert.match(failures[0], /never shows the reader the thing it tells them to run/);
    });
});

test('the installation page is allowed to be commands, and it is named rather than guessed', () => {
  run({ 'get-started/installation.mdx': page('Installation', 'Start here.\n\n```bash\nnpm install @obversa/runtime\n```\n') },
    (failures) => assert.deepEqual(failures, []));
});

test('an opening that defines the title is reported', () => {
  run({ 'a.mdx': page('Forge helper', 'A forge is a code host such as GitHub.\n\n```ts\nconst x = 1;\n```\n') },
    (failures) => {
      assert.equal(failures.length, 1, failures.join('; '));
      assert.match(failures[0], /opens by defining "Forge helper"/);
    });
});

test('a definition of something else is left alone', () => {
  run({ 'a.mdx': page('Workflows', 'A code host is where your branch ends up.\n\n```ts\nconst x = 1;\n```\n') },
    (failures) => assert.deepEqual(failures, []));
});

test('a sentence that merely contains the title word is not a definition', () => {
  run({ 'a.mdx': page('Workflows', 'Your team already has workflows; this writes one down.\n\n```ts\nconst x = 1;\n```\n') },
    (failures) => assert.deepEqual(failures, []));
});

test('a heading, an authoring note and a component are skipped when finding the first line', () => {
  const body = '{/* a note to the seat */}\n\n<Card>x</Card>\n\n## A heading\n\nRun it in one command.\n\n```ts\nconst x = 1;\n```\n';
  run({ 'a.mdx': page('Workflows', body) }, (failures) => assert.deepEqual(failures, []));
});

test('a page that opens with code is not judged on its first line', () => {
  run({ 'a.mdx': page('Workflows', '```ts\nconst x = 1;\n```\n\nA workflow is the shape of the work.\n') },
    (failures) => assert.deepEqual(failures, []));
});

test('both faults on one page are reported separately, so neither hides the other', () => {
  run({ 'a.mdx': page('Orders', 'An order is a unit of work.\n') }, (failures) => {
    assert.equal(failures.length, 2, failures.join('; '));
    assert.ok(failures.some((f) => /no example/.test(f)));
    assert.ok(failures.some((f) => /opens by defining/.test(f)));
  });
});

test('a page named in the debt list is forgiven for that fault only', () => {
  const dir = siteWith({ 'a.mdx': page('Orders', 'An order is a unit of work.\n') });
  try {
    const failures = checkPageShape(dir, {
      debt: debt([{ page: 'a.mdx', fault: 'example', owner: 'D36', why: 'its example is a team that takes a worktree' }]),
    });
    assert.equal(failures.length, 1, failures.join('; '));
    assert.match(failures[0], /opens by defining/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a page not in the debt list still fails, so the list is not a blanket', () => {
  const dir = siteWith({ 'a.mdx': page('Orders', 'Only prose.\n'), 'b.mdx': page('Surfaces', 'Only prose.\n') });
  try {
    const failures = checkPageShape(dir, {
      debt: debt([{ page: 'a.mdx', fault: 'example', owner: 'D36', why: 'queued' }]),
    });
    assert.equal(failures.length, 1, failures.join('; '));
    assert.match(failures[0], /^b\.mdx/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an exemption with no stage against it is refused, which is the point of the list', () => {
  assert.throws(
    () => buildDebtIndex([{ page: 'a.mdx', fault: 'example', why: 'queued' }]),
    /names no stage that owns the fix/,
  );
});

test('an exemption that does not say what it hides is refused too', () => {
  assert.throws(
    () => buildDebtIndex([{ page: 'a.mdx', fault: 'example', owner: 'D36' }]),
    /does not say what it hides/,
  );
});

test('an exemption whose owner has landed is refused, like one with no owner at all', () => {
  assert.throws(
    () => buildDebtIndex(
      [{ page: 'a.mdx', fault: 'example', owner: 'D34', why: 'queued' }],
      { landed: new Set(['D34']) },
    ),
    /names D34, which has landed, so nobody owns this fault any more/,
  );
});

test('an exemption whose owner is still open is kept', () => {
  const index = buildDebtIndex(
    [{ page: 'a.mdx', fault: 'example', owner: 'D36', why: 'queued' }],
    { landed: new Set(['D34']) },
  );
  assert.equal(index.size, 1);
});

test('an owner that is not a registered stage yet is kept, because a planned stage has no branch', () => {
  const index = buildDebtIndex(
    [{ page: 'a.mdx', fault: 'example', owner: 'D99', why: 'planned' }],
    { landed: new Set(['D34']) },
  );
  assert.equal(index.size, 1);
});
