import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaudeCliEngine } from '@obversa/engine-claude-cli';
import { CodexEngine } from '@obversa/engine-codex';
import { GrokCliEngine } from '@obversa/engine-grok-cli';
import { OpenCodeCliEngine } from '@obversa/engine-opencode-cli';
import { run } from '@obversa/runtime';
import { featureDelivery } from '@obversa/teams';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} to the absolute CLI path before running this example.`);
  return value;
}

const workspace = await mkdtemp(join(tmpdir(), 'obversa-team-feature-'));
try {
  const analyse = {
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
  const implement = {
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
  const reviewer = {
    engine: new GrokCliEngine({
      executable: required('GROK_BIN'),
      version: '1.0.5',
      identity: { provider: 'xai', modelFamily: 'grok-4' },
      permissionMode: 'dontAsk',
    }),
    identity: {
      adapter: 'grok-cli',
      provider: 'xai',
      modelFamily: 'grok',
      model: 'grok-4',
    },
  };
  const approve = {
    engine: new OpenCodeCliEngine({
      executable: required('OPENCODE_BIN'),
      version: '1.18.23',
      identity: { provider: 'anthropic', modelFamily: 'claude' },
    }),
    identity: {
      adapter: 'opencode-cli',
      provider: 'anthropic',
      modelFamily: 'opencode',
      model: 'opencode-default',
    },
  };
  let testCommandsRun = 0;
  const result = await run(featureDelivery({
    brief: 'Deliver a pure triple(value) function in src/triple.mjs with a Node test in test/triple.test.mjs.',
    workspace,
    files: ['src/triple.mjs', 'test/triple.test.mjs'],
    test: { command: process.execPath, args: ['--test', 'test/triple.test.mjs'] },
    analyse,
    implement,
    reviewers: [{ name: 'correctness', seat: reviewer }],
    reviewThreshold: 1,
    approve,
  }), {
    cwd: workspace,
    onEvent: (event) => {
      if (event.kind === 'condition:result' && event.label === 'test') testCommandsRun += 1;
    },
  });
  assert.equal(result.outcome.status, 'pass');
  console.log(JSON.stringify({
    status: result.outcome.status,
    files: ['team-output/brief.md', 'team-output/approval.md', 'src/triple.mjs', 'test/triple.test.mjs', 'reviews/correctness.json'],
    testCommandsRun,
  }, null, 2));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
