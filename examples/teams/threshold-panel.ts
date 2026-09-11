import { ClaudeCliEngine } from '@obversa/engine-claude-cli';
import { CodexEngine } from '@obversa/engine-codex';
import { OpenCodeCliEngine } from '@obversa/engine-opencode-cli';
import { run } from '@obversa/runtime';
import { thresholdPanel } from '@obversa/teams';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} to the absolute CLI path before running this example.`);
  return value;
}

const workspace = process.cwd();
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
    modelFamily: 'gpt',
    model: 'gpt-5.6-luna',
  },
};
const scope = {
  engine: new OpenCodeCliEngine({
    executable: required('OPENCODE_BIN'),
    version: '1.18.23',
    identity: { provider: 'opencode', modelFamily: null },
  }),
  identity: {
    adapter: 'opencode-cli',
    provider: 'opencode',
    modelFamily: 'big-pickle',
    model: 'opencode/big-pickle',
  },
};
const team = thresholdPanel({
  brief: 'Write a pure double(value) function in src/double.mjs with a Node test in test/double.test.mjs.',
  workspace,
  files: ['src/double.mjs', 'test/double.test.mjs'],
  test: { command: 'node', args: ['--test', 'test/double.test.mjs'] },
  implement,
  reviewers: [
    { name: 'correctness', seat: correctness },
    { name: 'scope', seat: scope },
  ],
  threshold: 2,
});
const result = await run(team, { cwd: workspace });

console.log(JSON.stringify(result.outcome, null, 2));
