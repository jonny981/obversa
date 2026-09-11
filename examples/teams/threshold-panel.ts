import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaudeCliEngine } from '@obversa/engine-claude-cli';
import { CodexEngine } from '@obversa/engine-codex';
import { GrokCliEngine } from '@obversa/engine-grok-cli';
import { run } from '@obversa/runtime';
import { thresholdPanel } from '@obversa/teams';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} to the absolute CLI path before running this example.`);
  return value;
}

const workspace = await mkdtemp(join(tmpdir(), 'obversa-team-panel-'));
try {
  const implement = {
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
  const correctness = {
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
  const scope = {
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
  let testCommandsRun = 0;
  const result = await run(thresholdPanel({
    brief: 'Write a pure double(value) function in src/double.mjs with a Node test in test/double.test.mjs.',
    workspace,
    files: ['src/double.mjs', 'test/double.test.mjs'],
    test: { command: process.execPath, args: ['--test', 'test/double.test.mjs'] },
    implement,
    reviewers: [
      { name: 'correctness', seat: correctness },
      { name: 'scope', seat: scope },
    ],
    threshold: 2,
  }), {
    cwd: workspace,
    onEvent: (event) => {
      if (event.kind === 'condition:result' && event.label === 'test') testCommandsRun += 1;
    },
  });
  assert.equal(result.outcome.status, 'pass');
  console.log(JSON.stringify({
    status: result.outcome.status,
    files: ['src/double.mjs', 'test/double.test.mjs', 'reviews/correctness.json', 'reviews/scope.json'],
    testCommandsRun,
    threshold: '2 of 2',
  }, null, 2));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
