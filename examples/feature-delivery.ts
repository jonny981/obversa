import { claude } from '@obversa/engine-claude-cli';
import { codex } from '@obversa/engine-codex';
import {
  agentJob,
  approval,
  commandSucceeds,
  gateJob,
  pipeline,
  reviewPanel,
  revisionRequest,
  run,
  type Engine,
  type Job,
  type Outcome,
} from '@obversa/runtime';

interface FeatureDeliveryEngines {
  readonly analyse: Engine;
  readonly implement: Engine;
  readonly correctness: Engine;
  readonly tests: Engine;
  readonly api: Engine;
}

const FEATURE_BRIEF =
  'Build a retry helper that retries failed requests, caps attempts, and stops when the caller aborts.';

const realEngines: FeatureDeliveryEngines = {
  analyse: claude('claude-sonnet-4-5').engine,
  implement: codex('gpt-5.6-luna').engine,
  correctness: claude('claude-sonnet-4-5').engine,
  tests: codex('gpt-5.6-luna').engine,
  api: claude('claude-sonnet-4-5').engine,
};

function responseOutcome(text: string, target?: string): Outcome {
  try {
    const value = JSON.parse(text) as {
      status?: unknown;
      summary?: unknown;
      findings?: unknown;
    };
    if (value.status === 'pass') {
      return {
        status: 'pass',
        summary: typeof value.summary === 'string' ? value.summary : 'accepted',
      };
    }
    if (value.status === 'revise' && target) {
      const findings = Array.isArray(value.findings)
        ? value.findings.map((finding) => ({
            reviewer: 'agent',
            severity: 'block' as const,
            evidence: typeof finding === 'string' ? finding : JSON.stringify(finding),
          }))
        : [{ reviewer: 'agent', severity: 'block' as const, evidence: 'the reviewer requested a repair' }];
      return revisionRequest({
        target,
        reason: typeof value.summary === 'string' ? value.summary : 'the reviewer requested a repair',
        findings,
      });
    }
  } catch {
    // A plain reply is still useful evidence for an analysis stage.
  }
  return { status: 'pass', summary: text.trim().slice(0, 280), data: text };
}

function worker(
  label: string,
  engine: Engine,
  prompt: string,
  target?: string,
): Job {
  return agentJob({
    label,
    engine,
    prompt,
    consumeFeedback: target !== undefined,
    outcome: (text) => responseOutcome(text, target),
  });
}

function createFeatureDelivery(
  engines: FeatureDeliveryEngines = realEngines,
): Job {
  const analyse = worker(
    'analyse',
    engines.analyse,
    `Read this brief: ${FEATURE_BRIEF}
Define the accepted criteria for a retry helper:
- a failed request is retried until it succeeds;
- retry attempts are capped;
- an aborted caller stops the retry.
Write no source or test files. Reply with JSON containing status "pass" and a short summary.`,
  );

  const implement = worker(
    'implement',
    engines.implement,
    `Implement the accepted retry criteria in src/retry.js and test/retry.test.js.
On the first pass, write tests for retrying and the attempt cap, then write the matching source.
When review feedback names a missing criterion, add that test and repair the source.
Run no command; the test stage runs the declared command. Reply with JSON containing status "pass" and a short summary.`,
    'implement',
  );

  const test = gateJob(
    'test',
    commandSucceeds('node', ['--test', 'test/retry.test.js'], {
      timeoutMs: 30_000,
      captureOutput: true,
    }),
  );

  const review = reviewPanel({
    label: 'review-panel',
    reviewers: [
      {
        name: 'correctness',
        job: worker(
          'correctness',
          engines.correctness,
          `Read src/retry.js against the accepted retry criteria. Check retrying, the attempt cap, and abort handling.
Reply with JSON: status "pass" when all three are implemented, or status "revise" with a findings array naming each missing criterion.`,
          'implement',
        ),
      },
      {
        name: 'tests',
        job: worker(
          'tests',
          engines.tests,
          `Read test/retry.test.js against the accepted retry criteria.
Reply with JSON: status "pass" when the tests cover retrying, the attempt cap, and abort handling, or status "revise" with a findings array naming each missing test.`,
          'implement',
        ),
      },
      {
        name: 'api',
        job: worker(
          'api',
          engines.api,
          `Read src/retry.js as a public module. Check that it exports retry and MAX_ATTEMPTS and keeps the function usable with an AbortSignal.
Reply with JSON: status "pass" when the module shape is correct, or status "revise" with a findings array.`,
          'implement',
        ),
      },
    ],
    pass: 2,
    target: 'implement',
  });

  const approve = approval('approve', {
    question: 'Approve shipping the retry helper and its tests?',
    target: 'implement',
  });

  return pipeline(
    'feature-delivery',
    [
      { name: 'analyse', job: analyse },
      { name: 'implement', job: implement },
      { name: 'test', job: test },
      { name: 'review', job: review },
      { name: 'approve', job: approve },
    ],
    { maxKickbacks: 2 },
  );
}

const result = await run(createFeatureDelivery(), { recordTo: 'auto' });
console.log(JSON.stringify({ status: result.outcome.status }, null, 2));
if (result.outcome.status === 'fail') process.exitCode = 1;
