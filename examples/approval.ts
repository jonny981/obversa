/**
 * A person decides.
 *
 * The last step of a delivery is a question to a person: ship this change?
 * `approval` asks it through the run's callbacks client. A yes passes the
 * step. A no goes back to the step that owns the fix with the person's note
 * as the finding, and the work comes round again. With nobody answering, the
 * run pauses with the question pending and carries on, when it runs again
 * with the same client, from the answer. This runs offline, with no model and
 * no network: the writer is a small function that leaves the header row out
 * once, and the person answers from this file.
 */
import { approval, fnJob, pipeline, run, type CallbackRequest } from '@obversa/runtime';

const analyse = fnJob('analyse', () => 'the ticket asks for a report export with a header row');

/** The writer. In a real team this is an agent; here it forgets the header once. */
let implementRuns = 0;
const implement = fnJob('implement', () => {
  implementRuns += 1;
  return implementRuns === 1 ? 'report.csv, rows only' : 'report.csv, header and rows';
});

/**
 * The person. The question is about what came before (the outcome of
 * `implement`), so a second attempt is a new question. In a real team the
 * answer arrives through the callbacks client; here it is decided in place.
 */
const decisions: string[] = [];
const approve = approval('approve', {
  question: 'Ship this change?',
  target: 'implement',
  answer: (request: CallbackRequest) => {
    const approved = JSON.stringify(request.input).includes('header');
    decisions.push(approved ? 'yes' : 'no');
    return approved
      ? { approved: true }
      : { approved: false, note: 'the ticket asked for a header row' };
  },
});

export const shipIt = pipeline(
  'ship-it',
  [
    { name: 'analyse', job: analyse },
    { name: 'implement', job: implement },
    { name: 'approve', job: approve },
  ],
  { maxKickbacks: 1 },
);

const result = await run(shipIt);
console.log(JSON.stringify({
  status: result.outcome.status,
  implementRuns,
  decisions,
}, null, 2));

/**
 * Part of the documentation proof: it must fail when the behaviour it shows
 * stops happening. A refusal that quietly stopped sending the work back would
 * still print a passing run, and `implement` running once is the tell.
 */
const faults: string[] = [];
if (result.outcome.status !== 'pass') faults.push(`the run ended ${result.outcome.status}`);
if (implementRuns !== 2) faults.push(`implement ran ${implementRuns} time(s), so the refusal did not send the work back exactly once`);
if (decisions.join(',') !== 'no,yes') faults.push(`the person decided [${decisions.join(', ')}], not a no and then a yes`);
if (faults.length) {
  for (const fault of faults) console.error(fault);
  process.exitCode = 1;
}
