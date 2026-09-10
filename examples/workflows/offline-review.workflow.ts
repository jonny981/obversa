import { relative } from 'node:path';
import {
  defineJob,
  fnJob,
  loop,
  predicate,
  revisionRequest,
  run,
} from '@obversa/runtime';

let attempts = 0;
let config: { timeoutMs?: number } | undefined;

const reviewLoop = defineJob(
  loop({
    name: 'write-config',
    max: 4,
    body: fnJob('author', async (ctx) => {
      attempts += 1;
      const fix = ctx.lastReview?.revision?.reason;
      config = {};
      if (fix) config.timeoutMs = 1_000;
      return {
        status: 'pass',
        summary: fix ? `added a timeout after: ${fix}` : 'wrote the base config',
      };
    }),
    until: predicate(() => config !== undefined, 'a draft exists'),
    review: fnJob('review', async () =>
      (config?.timeoutMs ?? 0) > 0
        ? { status: 'pass', summary: 'config is complete' }
        : revisionRequest({
            reason: 'Missing a request timeout.',
            findings: [
              {
                reviewer: 'correctness',
                evidence: 'No timeout set; a hung upstream call blocks forever.',
              },
            ],
          }),
    ),
  }),
);

async function main(): Promise<void> {
  // The run writes its record to .obversa/records/offline-review.jsonl so a
  // reader can open the file the docs describe.
  const result = await run(reviewLoop, { recordTo: '.obversa/records/offline-review.jsonl' });

  console.log(
    JSON.stringify(
      {
        status: result.outcome.status,
        attempts,
        summary: result.outcome.summary,
        record: result.recordPath ? relative(process.cwd(), result.recordPath) : null,
      },
      null,
      2,
    ),
  );

  if (result.outcome.status !== 'pass') process.exitCode = 1;
}

void main();
