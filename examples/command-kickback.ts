/**
 * A test suite as a node, and a command that chooses the path.
 *
 * No agent runs or watches the tests. `test` runs a command; when it fails,
 * its captured output goes straight back to `implement` as the finding, and
 * `implement` runs again with it in hand. `size` is a command too, and the two
 * reviews that depend on it each read its outcome and run only on their path.
 * It runs offline, with no model and no network: `implement` is a small
 * function that gets the code wrong once, so the kickback has something to do.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { commandSucceeds, dag, fnJob, gateJob, predicate, run, type Outcome } from '@obversa/runtime';

const workspace = mkdtempSync(join(tmpdir(), 'command-kickback-'));
const source = join(workspace, 'add.mjs');

/** The writer. In a real team this is an agent; here it gets the sign wrong once. */
let implementRuns = 0;
const implement = fnJob('implement', async (ctx): Promise<Outcome> => {
  implementRuns += 1;
  writeFileSync(
    source,
    implementRuns === 1
      ? 'export const add = (a, b) => a - b;\n'
      : 'export const add = (a, b) => a + b;\n',
  );
  return {
    status: 'pass',
    summary: ctx.lastReview
      ? `second attempt, after the tests said: ${ctx.lastReview.summary}`
      : 'first attempt',
  };
});

/** The tests, as a command. A red run goes back to `implement` with the output. */
const test = gateJob(
  'test',
  commandSucceeds(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { add } from ${JSON.stringify(source)};
       if (add(2, 2) !== 4) { console.error('add(2, 2) returned ' + add(2, 2)); process.exit(1); }`,
    ],
    { captureOutput: true },
  ),
  { target: 'implement' },
);

/** The decision, as a command: exit 0 for a small change, exit 1 for a large one. */
const size = gateJob(
  'size',
  commandSucceeds(process.execPath, [
    '-e',
    `process.exit(require('node:fs').readFileSync(${JSON.stringify(source)}).length > 200 ? 1 : 0)`,
  ]),
);

const reviewed: string[] = [];
const review = (name: string, summary: string) =>
  fnJob(name, async (): Promise<Outcome> => {
    reviewed.push(name);
    return { status: 'pass', summary };
  });

export const commandKickback = dag({
  name: 'command-kickback',
  maxKickbacks: 1,
  nodes: {
    implement: {
      desc: 'Write the change.',
      gate: 'The source file exists.',
      job: implement,
    },
    test: {
      needs: 'implement',
      desc: 'Run the tests; a red run goes back to implement with the output.',
      gate: 'The test command exits 0.',
      job: test,
    },
    size: {
      needs: 'test',
      optional: true,
      desc: 'Decide the review path from the size of the change.',
      gate: 'The size command has exited, either way.',
      job: size,
    },
    'quick-review': {
      needs: 'size',
      when: predicate((ctx) => ctx.needs?.size?.status === 'pass', 'the change is small'),
      desc: 'One reviewer reads a small change.',
      gate: 'The reviewer has read it.',
      job: review('quick-review', 'small change, one reader'),
    },
    'full-review': {
      needs: 'size',
      when: predicate((ctx) => ctx.needs?.size?.status === 'fail', 'the change is large'),
      desc: 'A panel reads a large change.',
      gate: 'The panel has read it.',
      job: review('full-review', 'large change, a panel'),
    },
  },
});

const result = await run(commandKickback);
rmSync(workspace, { recursive: true, force: true });
console.log(JSON.stringify({
  status: result.outcome.status,
  implementRuns,
  reviewed,
}, null, 2));

/**
 * Part of the documentation proof: it must fail when the behaviour it shows
 * stops happening. A test node that quietly stopped sending work back would
 * still print a passing run, and `implement` running once is the tell; a
 * decision that stopped choosing would run both reviews or neither.
 */
const faults: string[] = [];
if (result.outcome.status !== 'pass') faults.push(`the run ended ${result.outcome.status}`);
if (implementRuns !== 2) faults.push(`implement ran ${implementRuns} time(s), so the red test did not send the work back exactly once`);
if (reviewed.join(',') !== 'quick-review') faults.push(`the reviews that ran were [${reviewed.join(', ')}], not the one the size command chose`);
if (faults.length) {
  for (const fault of faults) console.error(fault);
  process.exitCode = 1;
}
