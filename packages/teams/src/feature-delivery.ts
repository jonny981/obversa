import { reviewPanel } from '@obversa/runtime';

import {
  assertDistinctSeats,
  assertKickbacks,
  assertReviewers,
  assertTeamInput,
  APPROVAL_NOTE,
  dag,
  DELIVERY_NOTE,
  expectedFilesPrompt,
  panelReviewers,
  requireNonEmptyFiles,
  teamAgent,
  teamTest,
} from './team-utils.js';
import type { FeatureDeliveryConfig } from './types.js';

export function featureDelivery(config: FeatureDeliveryConfig) {
  assertTeamInput(config);
  assertReviewers(config.reviewers, config.reviewThreshold);
  assertDistinctSeats([
    config.implement,
    ...config.reviewers.map(({ seat }) => seat),
  ]);
  const maxKickbacks = config.maxKickbacks ?? 1;
  assertKickbacks(maxKickbacks);
  const analyse = teamAgent(
    'analyse',
    config.analyse,
    config,
    `Write a delivery note to ${DELIVERY_NOTE} that names each requirement in the brief.`,
  );
  const implement = teamAgent(
    'implement',
    config.implement,
    config,
    `Read ${DELIVERY_NOTE}. Write the expected files. ${expectedFilesPrompt(config.files)} On a retry, apply the review findings before writing again.`,
    'implement',
  );
  const test = teamTest(config);
  const review = reviewPanel({
    label: 'review',
    reviewers: panelReviewers(config.reviewers, config),
    concurrency: config.reviewers.length,
    pass: config.reviewThreshold,
    target: 'implement',
  });
  const approve = teamAgent(
    'approve',
    config.approve,
    config,
    `Read the brief, implementation, test result, and review evidence. Write an approval note to ${APPROVAL_NOTE} stating that the change is ready to ship.`,
  );
  const checkedAnalyse = requireNonEmptyFiles(
    'analyse',
    analyse,
    config.workspace,
    [DELIVERY_NOTE],
  );
  const checkedImplement = requireNonEmptyFiles(
    'implement',
    implement,
    config.workspace,
    config.files,
  );
  const checkedApprove = requireNonEmptyFiles(
    'approve',
    approve,
    config.workspace,
    [APPROVAL_NOTE],
  );
  return dag({
    name: 'feature-delivery',
    stopOnError: true,
    maxKickbacks,
    nodes: {
      analyse: {
        job: checkedAnalyse,
        desc: 'Turn the brief into a delivery note the later steps can read.',
        gate: 'The delivery note is in the workspace and names each requirement.',
        needs: [],
      },
      implement: {
        job: checkedImplement,
        desc: 'Build the change from the delivery note, taking the last review into account.',
        gate: 'The code and its test cover every requirement in the note.',
        needs: ['analyse'],
      },
      test: {
        job: test,
        desc: 'Run the test command against the change.',
        gate: 'The test command exits 0.',
        needs: ['implement'],
      },
      review: {
        job: review,
        desc: 'Have the reviewers read the change and the test result and count the acceptances.',
        gate: 'At least the threshold number of reviewers have accepted.',
        needs: ['test'],
      },
      approve: {
        job: checkedApprove,
        desc: 'Record that the change is ready to ship.',
        gate: 'An approval note is in the workspace.',
        needs: ['review'],
      },
    },
  });
}
