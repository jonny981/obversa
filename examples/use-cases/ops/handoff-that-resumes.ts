import { claude } from '@obversa/engine-claude-cli';
import {
  briefFromFile,
  formatEvent,
  run,
  stage,
  workflow,
  type LoopEvent,
  type TeamSeat,
} from '@obversa/runtime';

interface ReportEngines {
  readonly claude: (model: string) => TeamSeat;
}

const realEngines: ReportEngines = { claude };

/**
 * A handoff that resumes from the record instead of from a summary. The
 * weekly service report is three stages: gather the facts from the log,
 * draft the report from the facts, and a check that fails the draft if an
 * incident is missing. The first worker is stopped after the first stage
 * finishes. The second worker is given nothing but the record: it reads
 * what finished, skips it, and carries on from the exact state. The
 * finished stage never runs again, and no seat repeats work.
 */
function createReport(engines: ReportEngines = realEngines) {
  return workflow('weekly-report', {
    brief: briefFromFile('briefs/report.md'),
    options: { timeout: '10m' },

    roles: {
      write: engines.claude('claude-sonnet-4-5'),
    },

    stages: [
      stage('gather', {
        agent: 'write',
        writes: 'report/facts.md',
        desc: 'One line per incident, as the log states it.',
        gate: 'report/facts.md names every incident in logs/week.md.',
      }),
      stage('draft', {
        agent: 'write',
        writes: 'report/draft.md',
        desc: 'The report a customer could read, from the facts alone.',
        gate: 'report/draft.md names every incident id in report/facts.md.',
        retry: 1,
      }),
      stage('check', {
        run: [process.execPath, 'tools/check-report.mjs'],
        desc: 'Fail the draft if an incident from the facts is missing.',
        gate: 'The check exits 0.',
        sendsBackTo: 'draft',
      }),
    ],
  });
}

const record = 'records/weekly-report.jsonl';

/** Which stages a worker ran, and which it took finished from the record. */
interface WorkerLog {
  ran: string[];
  fromRecord: string[];
}
function watch(worker: string, log: WorkerLog): (event: LoopEvent) => void {
  let open: string | undefined;
  let worked = false;
  return (event) => {
    console.log(`${worker} ${formatEvent(event)}`);
    if (event.kind === 'dag:node' && event.phase === 'start') { open = event.node; worked = false; }
    if (event.kind === 'job:start') worked = true;
    if (event.kind === 'dag:node' && event.phase === 'done' && event.node === open && event.outcome?.status === 'pass') {
      (worked ? log.ran : log.fromRecord).push(event.node);
      open = undefined;
    }
  };
}

// Worker one starts the run and is stopped the moment the first stage has
// finished, as a worker that lost its machine would be. Its record is the
// only thing it leaves behind.
const stop = new AbortController();
const worker1: WorkerLog = { ran: [], fromRecord: [] };
const watchWorker1 = watch('worker-1', worker1);
const first = await run(createReport(), {
  recordTo: record,
  signal: stop.signal,
  onEvent: (event) => {
    watchWorker1(event);
    if (event.kind === 'dag:node' && event.node === 'gather' && event.phase === 'done') stop.abort();
  },
});

// Worker two is given the record and nothing else. It reads what finished,
// skips it, and carries on from the draft.
const worker2: WorkerLog = { ran: [], fromRecord: [] };
const second = await run(createReport(), {
  recordTo: record,
  resume: true,
  onEvent: watch('worker-2', worker2),
});

console.log(JSON.stringify({
  status: second.outcome.status,
  worker1: { outcome: first.outcome.status, ...worker1 },
  worker2: { outcome: second.outcome.status, ...worker2 },
}, null, 2));
