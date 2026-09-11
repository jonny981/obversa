/**
 * A feature team, as one file.
 *
 * Five named stages, a review panel of three that passes on two, and work that
 * goes back to the stage that owns it when the panel fails. It runs offline,
 * with no model and no network: every job here is a small function, so the
 * shape of the team is the only thing on show.
 */
// README-SPAN-START imports
import { fnJob, pipeline, reviewPanel, run, type Outcome } from '@obversa/runtime';
// README-SPAN-END imports

/** The work itself. In a real team each of these calls an engine. */
const analyse = fnJob('analyse', async (): Promise<Outcome> => ({
  status: 'pass',
  summary: 'the ticket asks for a report export with a header row',
}));

/** Fails its first attempt so the panel has something to send back. */
let implementRuns = 0;
const implement = fnJob('implement', async (): Promise<Outcome> => {
  implementRuns += 1;
  return {
    status: 'pass',
    summary: implementRuns === 1 ? 'report.csv, rows only' : 'report.csv, header and rows',
  };
});

const testStage = fnJob('test', async (): Promise<Outcome> => ({
  status: 'pass',
  summary: 'the export parses',
}));

const approve = fnJob('approve', async (): Promise<Outcome> => ({
  status: 'pass',
  summary: 'released',
}));

/**
 * The three reviewers. Two of them fail the first attempt, because the panel
 * passes on two of three: one dissenting voice is not enough to send work
 * back, and an example where only one fails would show a panel that passes
 * and prove nothing about the kickback.
 */
const missingHeader = () => implementRuns === 1;
const checks = {
  correctness: fnJob('correctness', async (): Promise<Outcome> =>
    missingHeader()
      ? { status: 'fail', summary: 'the export is missing its header row' }
      : { status: 'pass', summary: 'header and rows present' }),
  safety: fnJob('safety', async (): Promise<Outcome> => ({ status: 'pass', summary: 'no destructive path' })),
  scope: fnJob('scope', async (): Promise<Outcome> =>
    missingHeader()
      ? { status: 'fail', summary: 'the ticket asked for a header row' }
      : { status: 'pass', summary: 'inside the ticket' }),
};

// README-SPAN-START team
const review = reviewPanel({
  label: 'review',
  reviewers: [
    { name: 'correctness', job: checks.correctness },
    { name: 'safety', job: checks.safety },
    { name: 'scope', job: checks.scope },
  ],
  pass: 2, // two of three agree and the step passes
  target: 'implement', // a failing panel sends the work back here
});

export const featureDelivery = pipeline(
  'feature-delivery',
  [
    { name: 'analyse', job: analyse },
    { name: 'implement', job: implement },
    { name: 'test', job: testStage },
    { name: 'review', job: review },
    { name: 'approve', job: approve },
  ],
  { maxKickbacks: 2 },
);
// README-SPAN-END team

const result = await run(featureDelivery);
console.log(JSON.stringify({
  status: result.outcome.status,
  implementRuns,
}, null, 2));

/**
 * The example is part of the documentation proof, so it has to fail the build
 * when the behaviour it shows stops happening. Printing alone would not: a
 * panel that quietly stopped sending work back would still print a passing
 * run, and `implement` running once is the tell.
 */
const faults: string[] = [];
if (result.outcome.status !== 'pass') {
  faults.push(`the run ended ${result.outcome.status}, so the second attempt never satisfied the panel`);
}
if (implementRuns !== 2) {
  faults.push(`implement ran ${implementRuns} time(s), so the panel did not send the work back exactly once`);
}
if (faults.length) {
  for (const fault of faults) console.error(fault);
  process.exitCode = 1;
}
