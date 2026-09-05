import { spawn } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { compileGraph, dagGraphType, EngineIncompleteResultError } from '@obversa/runtime';

const value = 'original';
await appendFile(new URL('./module-evaluations.log', import.meta.url), `${process.pid}\n`);

export async function bindRun({ definition, scratchDirectory }) {
  const input = definition.resolvedInputs;
  const graph = compileGraph(dagGraphType, definition.graphDefinition.value);
  const lane = definition.graphDefinition.value.nodes[0].data.lane;
  const selection = { adapter: 'fixture', adapterVersion: '1', provider: 'fixture', modelFamily: 'fixture', model: 'fixture', executable: null, capabilities: [] };
  return {
    graph,
    engines: lane ? [{
      target: lane.requested, selection, hardTokenLimitEnforceable: false,
      engine: {
        name: 'fixture',
        async run(request) {
          const evidence = {
            usage: { kind: 'reported', inputTokens: 7, outputTokens: 3 },
            requested: selection, effective: selection,
          };
          if (input.engineFail) throw new EngineIncompleteResultError('fixture incomplete', {
            ...evidence, parts: [{ kind: 'assistant', text: 'partial', final: false }],
            transportFailure: { kind: 'timeout', message: 'fixture timeout', exitCode: 9 },
          });
          return { ...evidence, parts: [{ kind: 'structured', value: { node: request.attempt.leafId, value }, final: true }] };
        },
      },
    }] : [],
    nodes: Object.fromEntries(definition.graphDefinition.value.nodes.map(({ id }) => [id, {
      prompt: lane ? () => 'fixture prompt' : null,
      scratchDirectory,
      workspace: { mode: 'none', directory: null, allowedPaths: [] },
      trustedCaller: { actor: 'fixture', provenance: 'local-test' },
      permissions: [],
      policy: {
        inputBytes: 10_000, outputBytes: 10_000, timeoutMs: input.nodeTimeoutMs ?? 5_000,
        teardownGraceMs: 100, memoryBytes: 10_000_000,
        filesChanged: 0, linesChanged: 0, callTokens: null,
      },
      resultContract: null,
      runData: lane ? null : async ({ signal }) => {
        await appendFile(join(scratchDirectory, `${id}.started`), `${process.pid}\n`);
        if (input.child) {
          const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: input.detachedChild === true, stdio: 'ignore' });
          await appendFile(join(scratchDirectory, `${id}.child`), `${child.pid}\n`);
        }
        if (input.noisy) {
          for (;;) {
            await new Promise((resolve) => process.stdout.write('x'.repeat(65_536), resolve));
          }
        }
        if (input.crash) process.kill(process.pid, 'SIGKILL');
        if (input.delayMs) await delay(input.delayMs, undefined, { signal });
        return { node: id, value: input.value ?? value };
      },
      parseResult: null, tokenBudget: null, retrySafe: true,
      decideAction: async () => input.wait
        ? { kind: 'wait', reason: 'A person must approve.', request: { kind: 'human' } }
        : input.deny ? { kind: 'deny', reason: 'Not permitted.' } : { kind: 'allow' },
    }])),
  };
}
