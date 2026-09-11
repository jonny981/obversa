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

/**
 * The first two rules are tested with pages whose code blocks are whole files
 * by construction: every TypeScript block is written under examples/ and
 * given a script, so the third rule has nothing to say about them.
 */
function run(pages, assertions) {
  const dir = siteWith(pages);
  const scripts = {};
  const compiled = new Set();
  let n = 0;
  for (const body of Object.values(pages)) {
    for (const match of body.matchAll(/```(?:ts|js)\n([\s\S]*?)```/g)) {
      const name = `block-${n++}.ts`;
      mkdirSync(join(dir, 'examples'), { recursive: true });
      writeFileSync(join(dir, 'examples', name), match[1]);
      scripts[`example:block-${n}`] = `tsx ../../examples/${name}`;
      compiled.add(name);
    }
  }
  scripts['verify:t'] = Object.keys(scripts).map((name) => `pnpm ${name}`).join(' && ');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }));
  try { assertions(checkPageShape(dir, { compiled })); } finally { rmSync(dir, { recursive: true, force: true }); }
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

test('an example named as if it were a feature is reported, and the same example named as a file is not', () => {
  // The page quotes offline-review.ts whole, so only the naming is judged.
  const dir = siteWith({ 'a.mdx': page('Reviews', 'Run the offline review workflow and read its output.\n\n```ts\nexport {};\n```\n') });
  try {
    mkdirSync(join(dir, 'examples'), { recursive: true });
    writeFileSync(join(dir, 'examples', 'offline-review.ts'), 'export {};\n');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { 'verify:t': 'pnpm example:offline', 'example:offline': 'tsx ../../examples/offline-review.ts' } }));
    const compiled = new Set(['offline-review.ts']);
    const failures = checkPageShape(dir, { compiled });
    assert.equal(failures.length, 1, failures.join('; '));
    assert.match(failures[0], /names an example as if it were a feature: "the offline review workflow"/);
    writeFileSync(join(dir, 'docs', 'public', 'a.mdx'), page('Reviews', 'Run `examples/offline-review.ts` and read its output.\n\n```ts\nexport {};\n```\n'));
    assert.deepEqual(checkPageShape(dir, { compiled }), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * The third rule: every TypeScript block is a whole example file that the
 * chain runs and the clean consumer compiles. Sites here carry an examples
 * directory and a manifest so the rule has something to compare against.
 */
function siteWithExamples(pages, examples, scripts) {
  const dir = siteWith(pages);
  for (const [name, body] of Object.entries(examples)) {
    const path = join(dir, 'examples', name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }));
  return dir;
}

function runWithExamples({ pages, examples, scripts, compiled, debt: entries }, assertions) {
  const dir = siteWithExamples(pages, examples, scripts);
  const options = { compiled: new Set(compiled ?? []) };
  if (entries) options.debt = debt(entries);
  try { assertions(checkPageShape(dir, options)); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const whole = "import { run } from '@obversa/runtime';\n\nconsole.log(await run(() => 1));\n";
const ran = { 'verify:t': 'pnpm example:whole', 'example:whole': 'pnpm --filter @obversa/runtime exec tsx ../../examples/whole.ts' };

test('a block that is a whole example file, run by a script and compiled by the consumer, passes', () => {
  runWithExamples({
    pages: { 'a.mdx': page('Teams', `Run the team.\n\n\`\`\`ts\n${whole}\`\`\`\n`) },
    examples: { 'whole.ts': whole }, scripts: ran, compiled: ['whole.ts'],
  }, (failures) => assert.deepEqual(failures, []));
});

test('a block cut from a file is reported, and the message says where the block starts', () => {
  runWithExamples({
    pages: { 'a.mdx': page('Teams', 'Run the team.\n\n```ts\nconsole.log(await run(() => 1));\n```\n') },
    examples: { 'whole.ts': whole }, scripts: ran, compiled: ['whole.ts'],
  }, (failures) => {
    assert.equal(failures.length, 1, failures.join('; '));
    assert.match(failures[0], /a\.mdx: a ts block is not a whole file under examples\/ \(it starts "console\.log/);
  });
});

test('a whole file that no example script runs is reported', () => {
  runWithExamples({
    pages: { 'a.mdx': page('Teams', `Run the team.\n\n\`\`\`ts\n${whole}\`\`\`\n`) },
    examples: { 'whole.ts': whole }, scripts: {}, compiled: ['whole.ts'],
  }, (failures) => {
    assert.equal(failures.length, 1, failures.join('; '));
    assert.match(failures[0], /no example:\* script runs it/);
  });
});

test('a whole file the clean consumer does not compile is reported', () => {
  runWithExamples({
    pages: { 'a.mdx': page('Teams', `Run the team.\n\n\`\`\`ts\n${whole}\`\`\`\n`) },
    examples: { 'whole.ts': whole }, scripts: ran, compiled: [],
  }, (failures) => {
    assert.equal(failures.length, 1, failures.join('; '));
    assert.match(failures[0], /the clean consumer does not compile it/);
  });
});

test('a file in a subdirectory of examples counts, and a trailing newline does not', () => {
  runWithExamples({
    pages: { 'a.mdx': page('Teams', `Run the team.\n\n\`\`\`ts\n${whole.trimEnd()}\n\`\`\`\n`) },
    examples: { 'teams/whole.ts': whole }, scripts: { 'verify:t': 'pnpm example:t', 'example:t': 'tsx ../../examples/teams/whole.ts' }, compiled: ['teams/whole.ts'],
  }, (failures) => assert.deepEqual(failures, []));
});

test('a command block is not judged by the whole-file rule', () => {
  runWithExamples({
    pages: { 'a.mdx': page('Teams', `Run the team.\n\n\`\`\`bash\nnpm install @obversa/runtime\n\`\`\`\n\n\`\`\`ts\n${whole}\`\`\`\n`) },
    examples: { 'whole.ts': whole }, scripts: ran, compiled: ['whole.ts'],
  }, (failures) => assert.deepEqual(failures, []));
});

test('a page in the debt list for wholefile is forgiven for that fault only', () => {
  runWithExamples({
    pages: { 'a.mdx': page('Teams', 'Teams are groups.\n\n```ts\nconst x = 1;\n```\n') },
    examples: {}, scripts: {}, compiled: [],
    debt: [{ page: 'a.mdx', fault: 'wholefile', owner: 'D99', why: 'w' }],
  }, (failures) => {
    assert.equal(failures.length, 1, failures.join('; '));
    assert.match(failures[0], /opens by defining/);
  });
});

test('a whole file whose script no verify chain calls is reported as not run', () => {
  runWithExamples({
    pages: { 'a.mdx': page('Teams', `Run the team.\n\n\`\`\`ts\n${whole}\`\`\`\n`) },
    examples: { 'whole.ts': whole }, scripts: { 'example:whole': 'tsx ../../examples/whole.ts' }, compiled: ['whole.ts'],
  }, (failures) => {
    assert.equal(failures.length, 1, failures.join('; '));
    assert.match(failures[0], /no example:\* script runs it/);
  });
});
