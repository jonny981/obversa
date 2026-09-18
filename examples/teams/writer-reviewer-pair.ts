import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex';
import { run } from '@obversa/runtime';
import { fromFile, stage, workflow, type TeamSeat } from '@obversa/teams';

interface WriterReviewerEngines {
  readonly claude: (model: string) => TeamSeat;
  readonly codex: (model: string) => TeamSeat;
}

const realEngines: WriterReviewerEngines = { claude, codex };

function createWriterReviewerPair(engines: WriterReviewerEngines = realEngines) {
  return workflow('writer-reviewer-pair', {
    brief: fromFile('briefs/add.md'),
    options: { timeout: '10m' },

    roles: {
      write: engines.claude('claude-sonnet-4-5'),
      review: [engines.codex('gpt-5.6-luna')],
    },

    stages: [
      stage('write', {
        agent: 'write',
        writes: ['src/add.mjs', 'test/add.test.mjs'],
        desc: 'Write the function and its test from the brief.',
        gate: 'The files named in the brief exist in the workspace.',
        retry: 1,
      }),
      stage('test', {
        run: ['node', '--test', 'test/add.test.mjs'],
        desc: 'Run the test command against the written files.',
        gate: 'The test command exits 0.',
        sendsBackTo: 'write',
      }),
      stage('review', {
        panel: 'review',
        agree: 1,
        desc: 'Read the code, the test and its result.',
        gate: 'The change meets the brief.',
        sendsBackTo: 'write',
      }),
    ],
  });
}

const result = await run(createWriterReviewerPair());
console.log(JSON.stringify(result.outcome, null, 2));
