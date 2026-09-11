/**
 * The first file a reader writes.
 *
 * Two steps and a dependency between them, in the shape every larger workflow
 * uses: nodes with names, each saying what it is for, and `needs` saying what
 * has to happen first. It runs offline with no model, so the shape is the only
 * thing on show.
 */
import { dag, fnJob, run, type Outcome } from '@obversa/runtime';

const draft = fnJob('draft', async (): Promise<Outcome> => ({
  status: 'pass',
  summary: 'wrote the first version',
}));

const review = fnJob('review', async (ctx): Promise<Outcome> => ({
  status: 'pass',
  summary: `read ${ctx.lastOutcome?.summary ?? 'the draft'}`,
}));

export const writeAndReview = dag({
  name: 'write-and-review',
  nodes: {
    draft: { desc: 'Write the first version', job: draft },
    review: { desc: 'Read it and say whether it stands', needs: 'draft', job: review },
  },
});

const result = await run(writeAndReview);
console.log(JSON.stringify({ status: result.outcome.status }, null, 2));

if (result.outcome.status !== 'pass') process.exitCode = 1;
