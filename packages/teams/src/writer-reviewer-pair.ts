import {
  assertDistinctSeats,
  assertKickbacks,
  assertTeamInput,
  dag,
  expectedFilesPrompt,
  requireNonEmptyFiles,
  teamAgent,
  teamTest,
} from './team-utils.js';
import type { PairConfig } from './types.js';

export function writerReviewerPair(config: PairConfig) {
  assertTeamInput(config);
  assertDistinctSeats([config.writer, config.reviewer]);
  const maxKickbacks = config.maxKickbacks ?? 1;
  assertKickbacks(maxKickbacks);
  const writer = teamAgent(
    'writer',
    config.writer,
    config,
    `Write the expected files from the brief. ${expectedFilesPrompt(config.files)} On a retry, apply the review findings before writing again.`,
    'writer',
  );
  const checkedWriter = requireNonEmptyFiles(
    'writer',
    writer,
    config.workspace,
    config.files,
  );
  const test = teamTest(config);
  const reviewer = teamAgent(
    'reviewer',
    config.reviewer,
    config,
    `Review the expected files against the brief. ${expectedFilesPrompt(config.files)} Write your review evidence under reviews/reviewer.json.`,
    'writer',
  );
  return dag({
    name: 'writer-reviewer-pair',
    stopOnError: true,
    maxKickbacks,
    nodes: {
      writer: {
        job: checkedWriter,
        desc: 'Write the code and its test from the brief.',
        gate: 'The files named in the brief exist in the workspace.',
        needs: [],
      },
      test: {
        job: test,
        desc: 'Run the test command against the written files.',
        gate: 'The test command exits 0.',
        needs: ['writer'],
      },
      reviewer: {
        job: reviewer,
        desc: 'Read the code and the test result and accept or send the work back.',
        gate: 'A different model family has accepted the change.',
        needs: ['test'],
      },
    },
  });
}
