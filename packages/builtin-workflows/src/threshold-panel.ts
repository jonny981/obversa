import { reviewPanel } from '@obversa/runtime';

import {
  assertDistinctSeats,
  assertKickbacks,
  assertReviewers,
  assertTeamInput,
  dag,
  expectedFilesPrompt,
  panelReviewers,
  requireNonEmptyFiles,
  teamAgent,
  teamTest,
} from './team-utils.js';
import type { PanelConfig } from './types.js';

export function thresholdPanel(config: PanelConfig) {
  assertTeamInput(config);
  assertReviewers(config.reviewers, config.threshold);
  assertDistinctSeats([config.implement, ...config.reviewers.map(({ seat }) => seat)]);
  const maxKickbacks = config.maxKickbacks ?? 1;
  assertKickbacks(maxKickbacks);
  const implement = teamAgent(
    'implement',
    config.implement,
    config,
    `Write the expected files from the brief. ${expectedFilesPrompt(config.files)} On a retry, apply the review findings before writing again.`,
    'implement',
  );
  const checkedImplement = requireNonEmptyFiles(
    'implement',
    implement,
    config.workspace,
    config.files,
  );
  const test = teamTest(config);
  const review = reviewPanel({
    label: 'review',
    reviewers: panelReviewers(config.reviewers, config),
    concurrency: config.reviewers.length,
    pass: config.threshold,
    target: 'implement',
  });
  return dag({
    name: 'threshold-panel',
    stopOnError: true,
    maxKickbacks,
    nodes: {
      implement: {
        job: checkedImplement,
        desc: 'Write the code and its test from the brief.',
        gate: 'The files named in the brief exist in the workspace.',
        needs: [],
      },
      test: {
        job: test,
        desc: 'Run the test command against the written files.',
        gate: 'The test command exits 0.',
        needs: ['implement'],
      },
      review: {
        job: review,
        desc: 'Have every reviewer read the change at the same time and count the acceptances.',
        gate: 'At least the threshold number of reviewers have accepted.',
        needs: ['test'],
      },
    },
  });
}
