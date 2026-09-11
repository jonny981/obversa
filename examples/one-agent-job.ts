import { agentJob, run } from '@obversa/runtime';
import { MockEngine } from '@obversa/runtime/testing';

const engine = new MockEngine(() => 'ready');

const job = agentJob({
  label: 'prepare-item',
  engine: 'offline',
  prompt: 'Prepare the item.',
});

const result = await run(job, {
  engine: 'offline',
  engines: { offline: engine },
});

console.log(result.outcome.status);
