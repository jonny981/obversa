import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex';
import { opencode } from '@obversa/engine-opencode-cli';
import { pathToFileURL } from 'node:url';
import { run } from '@obversa/runtime';
import { fromFile, stage, workflow, type TeamSeat } from '@obversa/teams';

export interface ThresholdPanelEngines {
  readonly claude: (model: string) => TeamSeat;
  readonly codex: (model: string) => TeamSeat;
  readonly opencode: (model: string) => TeamSeat;
}

const realEngines: ThresholdPanelEngines = {
  claude,
  codex,
  opencode: (model) => opencode(model, { executable: 'opencode' }),
};

export function createThresholdPanel(engines: ThresholdPanelEngines = realEngines) {
  return workflow('threshold-panel', {
    brief: fromFile('briefs/double.md'),
    options: { timeout: '10m' },

    roles: {
      implement: engines.claude('claude-sonnet-4-5'),
      review: [
        engines.codex('gpt-5.6-luna'),
        engines.opencode('opencode/big-pickle'),
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run(createThresholdPanel());
  console.log(JSON.stringify(result.outcome, null, 2));
}
