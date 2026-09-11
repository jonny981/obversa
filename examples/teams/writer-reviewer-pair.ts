import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ClaudeCliEngine } from '@obversa/engine-claude-cli';
import { CodexEngine } from '@obversa/engine-codex';
import { run } from '@obversa/runtime';
import { writerReviewerPair } from '@obversa/teams';

const workspace = await mkdtemp(join(tmpdir(), 'obversa-team-pair-'));
try {
  const writer = {
    engine: new ClaudeCliEngine({
      defaultModel: 'claude-sonnet-4-5',
      permissionMode: 'bypassPermissions',
    }),
    identity: {
      adapter: 'claude-cli',
      provider: 'anthropic',
      modelFamily: 'claude',
      model: 'claude-sonnet-4-5',
    },
  };
  const reviewer = {
    engine: new CodexEngine({
      defaultModel: 'gpt-5.6-luna',
      permissionMode: 'bypassPermissions',
    }),
    identity: {
      adapter: 'codex',
      provider: 'openai',
      modelFamily: 'codex',
      model: 'gpt-5.6-luna',
    },
  };
  let testCommandsRun = 0;
  const result = await run(writerReviewerPair({
    brief: 'Write a pure add(a, b) function in src/add.mjs with a Node test in test/add.test.mjs.',
    workspace,
    files: ['src/add.mjs', 'test/add.test.mjs'],
    test: { command: process.execPath, args: ['--test', 'test/add.test.mjs'] },
    writer,
    reviewer,
  }), {
    cwd: workspace,
    onEvent: (event) => {
      if (event.kind === 'condition:result' && event.label === 'test') testCommandsRun += 1;
    },
  });
  assert.equal(result.outcome.status, 'pass', JSON.stringify(result.outcome));
  const files = ['src/add.mjs', 'test/add.test.mjs', 'reviews/reviewer.json'];
  const captureDirectory = process.env.OBVERSA_TEAM_CAPTURE_DIR;
  if (captureDirectory) {
    for (const file of files) {
      const destination = join(captureDirectory, file);
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(workspace, file), destination);
    }
  }
  console.log(JSON.stringify({
    status: result.outcome.status,
    files,
    testCommandsRun,
    modelFamilies: [writer.identity.modelFamily, reviewer.identity.modelFamily],
  }, null, 2));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
