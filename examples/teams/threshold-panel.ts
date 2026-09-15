import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex';
import { resolveCommandExecutable } from '@obversa/engine/command';
import { opencode } from '@obversa/engine-opencode-cli';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  opencode: (model) => opencode(model, {
    executable: resolveCommandExecutable('opencode'),
  }),
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

// Resolve both paths because a symlink can change the spelling of one file.
const entryPath = process.argv[1];
const modulePath = fileURLToPath(import.meta.url);
if (entryPath && realpathSync(entryPath) === realpathSync(modulePath)) {
  const result = await run(createThresholdPanel());
  console.log(JSON.stringify(result.outcome, null, 2));
} else if (entryPath && basename(entryPath) === basename(modulePath)) {
  console.error('This example was started through a path that could not be matched to its module. Run the copied file directly.');
  process.exitCode = 1;
}
