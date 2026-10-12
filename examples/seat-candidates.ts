import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  dag,
  EngineError,
  fileAvailabilityStore,
  run,
  type TeamSeat,
} from '@obversa/runtime';
import { MockEngine } from '@obversa/runtime/testing';

const seat = (
  family: string,
  model: string,
  responder: () => string,
): TeamSeat => ({
  engine: new MockEngine(responder),
  identity: {
    adapter: 'mock',
    provider: 'mock',
    modelFamily: family,
    model,
    tools: ['Read'],
  },
});

const primary = seat('alpha', 'alpha-one', () => {
  throw new EngineError({
    kind: 'billing',
    message: 'credit balance too low',
    resetAt: Date.now() + 3_600_000,
    resetProven: true,
  });
});

const spare = seat('alpha', 'alpha-two', () => JSON.stringify({
  status: 'pass',
  summary: 'built on the second model',
}));

const graph = dag({
  name: 'seat-candidates',
  nodes: {
    build: {
      agent: {
        seat: primary,
        candidates: [spare],
      },
      writes: 'workspace',
      desc: 'Build the change.',
    },
  },
});

const cwd = await mkdtemp(join(tmpdir(), 'seat-candidates-'));
try {
  const result = await run(graph, {
    cwd,
    availability: fileAvailabilityStore(join(cwd, 'availability.json')),
  });
  console.log(result.outcome.status);
} finally {
  await rm(cwd, { recursive: true, force: true });
}
