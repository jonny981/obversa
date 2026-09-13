import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex';
import { opencode } from '@obversa/engine-opencode-cli';
import { run } from '@obversa/runtime';
import { fromFile, stage, workflow } from '@obversa/teams';

const executable = process.env.OPENCODE_BIN;
if (!executable) throw new Error('Set OPENCODE_BIN to the absolute OpenCode CLI path before running this example.');

const team = workflow('threshold-panel', {
  brief: fromFile('briefs/double.md'),
  options: { timeout: '10m' },

  roles: {
    implement: claude('claude-sonnet-4-5'),
    review: [
      codex('gpt-5.6-luna'),
      opencode('opencode/big-pickle', { executable }),
    ],
  },

  stages: [
    stage('implement', {
      agent: 'implement',
      writes: ['src/double.mjs', 'test/double.test.mjs'],
      desc: 'Write the function and its test from the brief.',
      gate: 'The files named in the brief exist in the workspace.',
      retry: 1,
    }),
    stage('test', {
      run: ['node', '--test', 'test/double.test.mjs'],
      desc: 'Run the test command against the written files.',
      gate: 'The test command exits 0.',
      sendsBackTo: 'implement',
    }),
    stage('review', {
      panel: 'review',
      agree: 1,
      desc: 'Have both reviewers read the change and count the acceptances.',
      gate: 'At least one reviewer has accepted.',
      sendsBackTo: 'implement',
    }),
  ],
});

const result = await run(team);
console.log(JSON.stringify(result.outcome, null, 2));
