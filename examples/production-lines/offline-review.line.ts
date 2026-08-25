import {
  defineJob,
  fnJob,
  loop,
  predicate,
  revisionRequest,
  run,
} from '@obversa/lines';

let attempts = 0;

const productionLine = defineJob(
  loop({
    name: 'write-config',
    max: 4,
    body: fnJob('author', async (ctx) => {
      attempts += 1;
      const fix = ctx.lastReview?.revision?.reason;
      return {
        status: 'pass',
        summary: fix ? `added a timeout after: ${fix}` : 'wrote the base config',
      };
    }),
    until: predicate(() => true, 'a draft exists'),
    review: fnJob('review', async () =>
      attempts > 1
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
  const result = await run(productionLine);

  console.log(
    JSON.stringify(
      {
        status: result.outcome.status,
        attempts,
        summary: result.outcome.summary,
      },
      null,
      2,
    ),
  );

  if (result.outcome.status !== 'pass') process.exitCode = 1;
}

void main();
