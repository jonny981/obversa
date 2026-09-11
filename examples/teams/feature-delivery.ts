// README-SPAN-START imports
import { ClaudeCliEngine } from '@obversa/engine-claude-cli';
import { CodexEngine } from '@obversa/engine-codex';
import { run } from '@obversa/runtime';
import { featureDelivery } from '@obversa/teams';
// README-SPAN-END imports

const workspace = process.cwd();
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
    modelFamily: 'gpt',
    model: 'gpt-5.6-luna',
  },
};
const reviewer = {
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
const approve = {
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

// README-SPAN-START team
const team = featureDelivery({
  brief: 'Deliver a pure triple(value) function in src/triple.mjs with a Node test in test/triple.test.mjs.',
  workspace,
  files: ['src/triple.mjs', 'test/triple.test.mjs'],
  test: { command: 'node', args: ['--test', 'test/triple.test.mjs'] },
  analyse,
  implement,
  reviewers: [{ name: 'correctness', seat: reviewer }],
  reviewThreshold: 1,
  approve,
});
// README-SPAN-END team

const result = await run(team, { cwd: workspace });
console.log(JSON.stringify(result.outcome, null, 2));
