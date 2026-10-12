import { agentJob, EngineError, fileAvailabilityStore, run } from '../src/api.js';
import type { AgentRequest, LoopEvent, TeamSeat } from '../src/api.js';
import { MockEngine } from '../src/testing.js';

const seat = (model: string, responder: (req: AgentRequest) => string): TeamSeat => ({
  engine: new MockEngine(responder),
  identity: {
    adapter: 'mock',
    provider: 'mock',
    modelFamily: model.split('-', 1)[0]!,
    model,
    tools: ['Read'],
  },
});

// The second attempt of the remembered-skip proof, run in a fresh process:
// the availability file the first process wrote is the only state carried
// over. The result, the call counts and the route events go back over
// stdout as one JSON line.
if (process.argv[2] === '--remembered-skip') {
  const [cwd, file] = process.argv.slice(3);
  if (!cwd || !file) throw new Error('missing remembered-skip fixture input');
  const callsA: string[] = [];
  const callsB: string[] = [];
  const primary = seat('alpha-one', (req) => {
    callsA.push(req.prompt);
    throw new EngineError({ kind: 'billing', message: 'credit balance too low' });
  });
  const alternate = seat('alpha-two', (req) => {
    callsB.push(req.prompt);
    return 'second seat answered';
  });
  const events: LoopEvent[] = [];
  const result = await run(
    agentJob({
      label: 'build',
      engine: primary.engine,
      model: primary.identity.model,
      identity: primary.identity,
      candidates: [alternate],
      prompt: 'do the work',
    }),
    {
      cwd,
      onEvent: (event) => events.push(event),
      availability: fileAvailabilityStore(file),
    },
  );
  process.stdout.write(`${JSON.stringify({
    status: result.outcome.status,
    data: result.outcome.data ?? null,
    callsA: callsA.length,
    callsB: callsB.length,
    routes: events.filter((event) => event.kind === 'seat:route'),
  })}\n`);
}
