import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TeamSeat } from '@obversa/api';
import { writerReviewerPair } from '@obversa/builtin-workflows';
import { MockEngine } from '@obversa/core/testing';
import { run } from '@obversa/runtime';

const workspace = await realpath(await mkdtemp(join(tmpdir(), 'obversa-pair-')));
const answer = join(workspace, 'answer.txt');
let writes = 0;
let reviews = 0;

try {
  const writer: TeamSeat = {
    engine: new MockEngine(() => {
      writes += 1;
      writeFileSync(answer, '42\n');
      return JSON.stringify({ status: 'pass', summary: 'Wrote the answer.' });
    }),
    identity: {
      adapter: 'mock', provider: 'local', modelFamily: 'writer',
      model: 'writer-offline', tools: ['Write'],
    },
  };
  const reviewer: TeamSeat = {
    engine: new MockEngine(() => {
      reviews += 1;
      assert.equal(readFileSync(answer, 'utf8'), '42\n');
      return JSON.stringify({ status: 'pass', summary: 'The answer matches the brief.' });
    }),
    identity: {
      adapter: 'mock', provider: 'local', modelFamily: 'reviewer',
      model: 'reviewer-offline', tools: ['Read'],
    },
  };
  const job = writerReviewerPair({
    brief: 'Write answer.txt containing 42 followed by a newline.',
    workspace,
    files: ['answer.txt'],
    writer,
    reviewer,
    test: {
      command: process.execPath,
      args: ['-e', 'require("node:assert/strict").equal(require("node:fs").readFileSync("answer.txt", "utf8"), "42\\n")'],
      timeoutMs: 5_000,
    },
  });
  const result = await run(job, { recordTo: join(workspace, 'run.jsonl') });
  assert.equal(result.outcome.status, 'pass');
  assert.equal(writes, 1);
  assert.equal(reviews, 1);
  console.log(JSON.stringify({ status: result.outcome.status, writes, reviews }, null, 2));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
