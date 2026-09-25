import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pass, sourceDir, withExample } from '../proof-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const samples = sourceDir(here);
const read = (path: string) => readFile(join(samples, path), 'utf8');

const facts = [
  '- INC-301: Monday 09:12, 18 minutes. Sign-in slow for a fifth of customers. A cache node restarted; fixed by failover.',
  '- INC-302: Wednesday 22:40, 2 hours 5 minutes. Exports queued and did not run. A worker pool at its limit; the limit was raised and the queue drained.',
  '- INC-303: Friday 14:03, 6 minutes. One region\'s status page showed stale data. A publishing job skipped; re-run.',
  '',
].join('\n');

const draft = [
  '# Weekly service report',
  '',
  'Three incidents this week, all resolved.',
  '',
  'INC-301 (Monday, 18 minutes): sign-in was slow for about a fifth of customers after a cache node restarted. Failover restored it.',
  '',
  'INC-302 (Wednesday night, just over two hours): exports queued and did not run because a worker pool was at its limit. The limit was raised and the queue drained.',
  '',
  'INC-303 (Friday, 6 minutes): one region\'s status page showed stale data after a publishing job skipped. The job was re-run.',
  '',
].join('\n');

// Two workers, one record, one seat. The first worker is stopped after
// the gather stage finishes. The second resumes from the record, takes the
// gather stage as finished, and runs the draft and the check. The seat is
// asked exactly twice: the finished stage is never run again.
await withExample({
  here,
  example: 'handoff-that-resumes',
  files: {
    'briefs/report.md': await read('briefs/report.md'),
    'logs/week.md': await read('logs/week.md'),
    'tools/check-report.mjs': await read('tools/check-report.mjs'),
  },
  seats: {
    claude: [
      { writes: { 'report/facts.md': facts }, reply: pass('three incidents, one line each') },
      { writes: { 'report/draft.md': draft }, reply: pass('the report, naming every incident') },
    ],
  },
}, async (run) => {
  const printed = run.printed as unknown as {
    status: string;
    worker1: { outcome: string; ran: string[]; fromRecord: string[] };
    worker2: { outcome: string; ran: string[]; fromRecord: string[] };
  };
  assert.equal(printed.status, 'pass', run.stdout);
  assert.equal(printed.worker1.outcome, 'aborted', 'the first worker was stopped');
  assert.deepEqual(printed.worker1.ran, ['gather']);
  assert.equal(printed.worker2.outcome, 'pass');
  assert.deepEqual(printed.worker2.fromRecord, ['gather'], 'the second worker took the finished stage from the record');
  assert.deepEqual(printed.worker2.ran, ['draft', 'check']);

  assert.equal(run.seatCalls.length, 2, 'gather once, draft once; nothing repeated');
  assert.match(await run.read('report/facts.md'), /INC-303/);
  assert.match(await run.read('report/draft.md'), /INC-301[\s\S]*INC-302[\s\S]*INC-303/);
  assert.ok(run.exists('records/weekly-report.jsonl'), 'both workers wrote to one record');

  console.log(JSON.stringify({
    status: 'pass',
    workers: 2,
    stages: 3,
    stoppedAfter: 'gather',
    resumedFromRecord: ['gather'],
    ranByTheSecondWorker: ['draft', 'check'],
    seatTurns: 2,
    mode: run.mode,
  }, null, 2));
});
