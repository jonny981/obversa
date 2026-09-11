import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { checkReadmeExamples } from './check-readme-examples.mjs';

const FEATURE = `import { run } from '@obversa/runtime';

const team = { name: 'feature' };

await run(team);
`;

function treeWith({ readme, example }) {
  const dir = mkdtempSync(join(tmpdir(), 'readme-examples-'));
  for (const [name, body] of Object.entries({
    'README.md': readme,
    'examples/teams/feature-delivery.ts': example,
  })) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

const wholeFile = "Intro.\n\n```ts\n" + FEATURE + "```\n";

function run(files, assertions) {
  const dir = treeWith(files);
  try { assertions(checkReadmeExamples(dir)); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a complete example file quoted byte for byte passes', () => {
  run({ readme: wholeFile, example: FEATURE }, ({ problems, files }) => {
    assert.deepEqual(problems, []);
    assert.equal(files, 1);
  });
});

test('a partial example file fails', () => {
  run({ readme: "Intro.\n\n```ts\nconst team = { name: 'feature' };\n```\n", example: FEATURE }, ({ problems }) => {
    assert.equal(problems.length, 2, problems.join('; '));
    assert.ok(problems.some((problem) => /not a complete example file/.test(problem)));
    assert.ok(problems.some((problem) => /does not quote the expected example file/.test(problem)));
  });
});

test('an invented block fails', () => {
  const invented = "Intro.\n\n```ts\nconst missing = true;\n```\n";
  run({ readme: invented, example: FEATURE }, ({ problems }) => {
    assert.equal(problems.length, 2, problems.join('; '));
    assert.ok(problems.some((problem) => /not a complete example file/.test(problem)));
    assert.ok(problems.some((problem) => /does not quote the expected example file/.test(problem)));
  });
});

test('a shell block is a command and is not held to an example', () => {
  run({ readme: wholeFile + "\n```bash\npnpm example:feature-team\n```\n", example: FEATURE },
    ({ problems }) => assert.deepEqual(problems, []));
});

test('the expected feature delivery file must be quoted', () => {
  run({ readme: 'Intro.\n', example: FEATURE }, ({ problems }) => {
    assert.equal(problems.length, 1, problems.join('; '));
    assert.match(problems[0], /does not quote the expected example file/);
  });
});

test('a trailing newline in the quoted block is allowed', () => {
  run({ readme: wholeFile, example: FEATURE }, ({ problems }) => {
    assert.deepEqual(problems, []);
  });
});
