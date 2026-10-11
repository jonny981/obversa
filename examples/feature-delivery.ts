import { resolveCommandExecutable } from '@obversa/core/command';
import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex-cli';
import { grok } from '@obversa/engine-grok-cli';
import { opencode } from '@obversa/engine-opencode-cli';
import {
  approval,
  pipeline,
  review as buildReview,
  run,
  type Job,
  type TeamSeat,
} from '@obversa/runtime';

interface FeatureDeliveryTeam {
  readonly analyse: TeamSeat;
  readonly implement: TeamSeat;
  readonly correctness: TeamSeat;
  readonly tests: TeamSeat;
  readonly api: TeamSeat;
}

const FEATURE_BRIEF =
  'Build a retry helper that retries failed requests, caps attempts, and stops when the caller aborts.';

// The OpenCode and Grok adapters need an absolute command path.
const realTeam: FeatureDeliveryTeam = {
  analyse: claude('claude-sonnet-4-5'),
  implement: codex('gpt-5.6-luna'),
  correctness: claude('claude-sonnet-4-5'),
  tests: opencode('google/gemini-2.5-pro', { executable: resolveCommandExecutable('opencode') }),
  api: grok('grok-4', { executable: resolveCommandExecutable('grok') }),
};

function createFeatureDelivery(
  seats: FeatureDeliveryTeam = realTeam,
): Job {
  const approve = approval('approve', {
    question: 'Approve shipping the retry helper and its tests?',
    target: 'implement',
  });

  return pipeline(
    'feature-delivery',
    [
      {
        name: 'analyse',
        desc: `Read this brief: ${FEATURE_BRIEF}
Define the accepted criteria for a retry helper:
- a failed request is retried until it succeeds;
- retry attempts are capped;
- an aborted caller stops the retry.`,
        gate: 'The accepted criteria are named.',
        agent: seats.analyse,
      },
      {
        name: 'implement',
        desc: `Implement the accepted retry criteria in src/retry.js and test/retry.test.js.
On the first pass, write tests for retrying and the attempt cap, then write the matching source.
When review feedback names a missing criterion, add that test and repair the source.
Run no command; the declared test check runs it.`,
        gate: 'The accepted criteria are implemented and node --test test/retry.test.js passes.',
        agent: seats.implement,
        writes: ['src/retry.js', 'test/retry.test.js'],
        // The stage's own refinement, each round: the test first, a red one
        // goes straight back with its output; then the three reviewers vote
        // as one panel, two passes enough; at most two send-backs.
        refine: buildReview({
          checks: [['node', '--test', 'test/retry.test.js']],
          reviewers: [
            { name: 'correctness', seat: seats.correctness, scope: 'src/retry.js against the accepted criteria: retrying, the attempt cap, and abort handling' },
            { name: 'tests', seat: seats.tests, scope: 'test/retry.test.js against the accepted criteria: retrying, the attempt cap, and abort handling' },
            { name: 'api', seat: seats.api, scope: 'src/retry.js as a public module: it exports retry and MAX_ATTEMPTS and keeps the function usable with an AbortSignal' },
          ],
          pass: 2,
          rounds: 2,
        }),
      },
      {
        name: 'approve',
        job: approve,
        sendsBackTo: ['implement'],
      },
    ],
    { brief: FEATURE_BRIEF },
  );
}

// The run waits for a person at approve and prints the address of a page
// to answer on. The wait lives in this process: stop it before the person
// answers, and the next run starts again from the first step.
const result = await run(createFeatureDelivery(), {
  recordTo: 'auto',
  onCallback: 'wait',
  monitor: true,
  onEvent: (event) => {
    if (event.kind === 'monitor') console.log(`Answer the approval on ${event.url}`);
  },
});
await result.monitor?.close();
console.log(JSON.stringify({ status: result.outcome.status }, null, 2));
if (result.outcome.status === 'fail') process.exitCode = 1;
