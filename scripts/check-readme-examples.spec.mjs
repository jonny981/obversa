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
const contiguousExcerpt = "Intro.\n\n```ts examples/teams/feature-delivery.ts (excerpt)\nconst team = { name: 'feature' };\n\nawait run(team);\n```\n";

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

test('a titled excerpt that is a contiguous run of its file passes', () => {
  run({ readme: contiguousExcerpt, example: FEATURE }, ({ problems, files }) => {
    assert.deepEqual(problems, []);
    assert.equal(files, 1);
  });
});

test('a titled excerpt whose lines are not one run of its file fails', () => {
  const skipsALine = "Intro.\n\n```ts examples/teams/feature-delivery.ts (excerpt)\nconst team = { name: 'feature' };\nawait run(team);\n```\n";
  run({ readme: skipsALine, example: FEATURE }, ({ problems }) => {
    assert.equal(problems.length, 1, problems.join('; '));
    assert.match(problems[0], /not a contiguous run of its lines/);
  });
});

test('a titled excerpt of a file that does not exist fails', () => {
  const missing = "Intro. See examples/teams/feature-delivery.ts.\n\n```ts examples/teams/other.ts (excerpt)\nawait run(team);\n```\n";
  run({ readme: missing, example: FEATURE }, ({ problems }) => {
    assert.equal(problems.length, 1, problems.join('; '));
    assert.match(problems[0], /names examples\/teams\/other\.ts, which does not exist/);
  });
});

test('an untitled partial example file fails', () => {
  run({ readme: "Intro.\n\n```ts\nconst team = { name: 'feature' };\n```\n", example: FEATURE }, ({ problems }) => {
    assert.equal(problems.length, 2, problems.join('; '));
    assert.ok(problems.some((problem) => /not a complete example file/.test(problem)));
    assert.ok(problems.some((problem) => /does not name the expected example file/.test(problem)));
  });
});

test('an invented block fails', () => {
  const invented = "Intro.\n\n```ts\nconst missing = true;\n```\n";
  run({ readme: invented, example: FEATURE }, ({ problems }) => {
    assert.equal(problems.length, 2, problems.join('; '));
    assert.ok(problems.some((problem) => /not a complete example file/.test(problem)));
    assert.ok(problems.some((problem) => /does not name the expected example file/.test(problem)));
  });
});

test('a shell block is a command and is not held to an example', () => {
  run({ readme: wholeFile + "\n```bash\npnpm example:feature-team\n```\n", example: FEATURE },
    ({ problems }) => assert.deepEqual(problems, []));
});

test('the expected feature delivery file must be named', () => {
  run({ readme: 'Intro.\n', example: FEATURE }, ({ problems }) => {
    assert.equal(problems.length, 1, problems.join('; '));
    assert.match(problems[0], /does not name the expected example file/);
  });
});

test('naming the expected file in prose is enough', () => {
  run({ readme: 'The team is examples/teams/feature-delivery.ts.\n', example: FEATURE }, ({ problems }) => {
    assert.deepEqual(problems, []);
  });
});

test('a trailing newline in the quoted block is allowed', () => {
  run({ readme: wholeFile, example: FEATURE }, ({ problems }) => {
    assert.deepEqual(problems, []);
  });
});
