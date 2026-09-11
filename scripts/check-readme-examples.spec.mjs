import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { checkReadmeExamples } from './check-readme-examples.mjs';

/**
 * The check runs in both directions and both of them have been the hole at
 * some point: a README block that quotes nothing that runs, and an example
 * whose marker was removed so nothing held its block to the file.
 */
const IMPORTS = "import { run } from '@obversa/runtime';";
const TEAM = "const review = reviewPanel({ pass: 2, target: 'implement' });";

function treeWith({ readme, example }) {
  const dir = mkdtempSync(join(tmpdir(), 'readme-examples-'));
  for (const [name, body] of Object.entries({
    'README.md': readme,
    'examples/feature-team.ts': example,
  })) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

const bothSpans = `// README-SPAN-START imports\n${IMPORTS}\n// README-SPAN-END imports\n\n// README-SPAN-START team\n${TEAM}\n// README-SPAN-END team\n`;
const bothQuoted = "Intro.\n\n```ts\n" + IMPORTS + "\n```\n\n```ts\n" + TEAM + "\n```\n";

function run(files, assertions) {
  const dir = treeWith(files);
  try { assertions(checkReadmeExamples(dir)); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('both spans quoted byte for byte pass', () => {
  run({ readme: bothQuoted, example: bothSpans }, ({ problems, spans }) => {
    assert.deepEqual(problems, []);
    assert.equal(spans, 2);
  });
});

test('a span the README does not quote fails', () => {
  run({ readme: "Intro.\n\n```ts\n" + IMPORTS + "\n```\n", example: bothSpans }, ({ problems }) => {
    assert.equal(problems.length, 1, problems.join('; '));
    assert.match(problems[0], /span "team" is not in the README byte for byte/);
  });
});

test('a README block that comes from no example fails, which is the direction that matters', () => {
  const invented = "Intro.\n\n```ts\n" + IMPORTS + "\n```\n\n```ts\n" + TEAM + "\n```\n\n```ts\nkickback('implement', 'missing header');\n```\n";
  run({ readme: invented, example: bothSpans }, ({ problems }) => {
    assert.equal(problems.length, 1, problems.join('; '));
    assert.match(problems[0], /appears in no example file/);
  });
});

test('a shell block is a command and is not held to an example', () => {
  run({ readme: bothQuoted + "\n```bash\npnpm example:feature-team\n```\n", example: bothSpans },
    ({ problems }) => assert.deepEqual(problems, []));
});

test('removing one of the two markers fails, rather than passing on the one that is left', () => {
  const oneSpan = `${IMPORTS}\n\n// README-SPAN-START team\n${TEAM}\n// README-SPAN-END team\n`;
  run({ readme: bothQuoted, example: oneSpan }, ({ problems }) => {
    assert.ok(problems.some((p) => /the span "imports" has no marker/.test(p)), problems.join('; '));
  });
});

test('a new marker nobody declared fails, so the guarded set stays deliberate', () => {
  const extra = `${bothSpans}\n// README-SPAN-START extra\nconst x = 1;\n// README-SPAN-END extra\n`;
  run({ readme: bothQuoted + "\n```ts\nconst x = 1;\n```\n", example: extra }, ({ problems }) => {
    assert.ok(problems.some((p) => /is not one this check expects/.test(p)), problems.join('; '));
  });
});
