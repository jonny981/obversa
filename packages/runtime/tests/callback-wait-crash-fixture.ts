import { readFileSync } from 'node:fs';

import { createStoredCallbackClient, run } from '../src/api.ts';
import { delivery, deployment, publicGate } from './callback-wait-delivery-fixture.ts';
import { openStoredRunFixtureStorage } from './stored-run-fixture.ts';

const [directory, runId, recordTo, cwd, resume, job] = process.argv.slice(2);
const storage = openStoredRunFixtureStorage('callback-wait', directory!);
const client = await createStoredCallbackClient(storage, runId!);
const recordStart = resume === 'true' ? readFileSync(recordTo!, 'utf8').length : 0;
let historyReads = 0;
process.channel?.unref();

// No AbortController or signal handler: the parent kills the actual waiter.
const waitingJob = job === 'deploy' ? deployment()
  : job === 'public-gate' || job === 'env-gate' ? publicGate(job === 'env-gate') : delivery();
const result = await run(waitingJob, {
  cwd: cwd!,
  recordTo: recordTo!,
  onCallback: 'wait',
  resume: resume === 'true',
  callbacks: {
    ...client,
    async history(requestId) {
      const events = await client.history(requestId);
      historyReads += 1;
      const requested = events.find((event) => event.kind === 'callback-requested');
      if (requested?.kind === 'callback-requested'
          && !events.some((event) => event.kind === 'callback-submitted')) {
        // Both a new and a saved request read before post, after post, then
        // during polling. Report the actual record, not the read count, as proof.
        if (historyReads === 3) {
          const checkpoint = readFileSync(recordTo!, 'utf8').slice(recordStart).split('\n').filter(Boolean)
            .map((line) => JSON.parse(line))
            .findLast((event) => event.kind === 'dag:node'
              && event.outcome?.status === 'paused'
              && event.outcome.data?.requestId === requested.request.requestId);
          process.send?.({ waiting: requested.request, checkpoint: checkpoint ?? null });
        }
      }
      return events;
    },
  },
});
console.log(result.outcome.status);
process.exitCode = result.outcome.status === 'pass' ? 0 : 1;
