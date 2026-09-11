import { ClaudeCliEngine } from '@obversa/engine-claude-cli';
import { CodexEngine } from '@obversa/engine-codex';
import { run } from '@obversa/runtime';
import { writerReviewerPair } from '@obversa/teams';

const workspace = process.cwd();
const writer = {
  engine: new ClaudeCliEngine({
    defaultModel: 'claude-sonnet-4-5',
    permissionMode: 'bypassPermissions',
  }),
  identity: {
    adapter: 'claude-cli',
    provider: 'anthropic',
    modelFamily: 'claude-sonnet-4-5',
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
    modelFamily: 'gpt-5.6-luna',
    model: 'gpt-5.6-luna',
  },
};
const team = writerReviewerPair({
  brief: 'Write a pure add(a, b) function in src/add.mjs with a Node test in test/add.test.mjs.',
  workspace,
  files: ['src/add.mjs', 'test/add.test.mjs'],
  test: { command: process.execPath, args: ['--test', 'test/add.test.mjs'] },
  writer,
  reviewer,
});
const result = await run(team, { cwd: workspace });

console.log(JSON.stringify(result.outcome, null, 2));
