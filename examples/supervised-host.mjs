import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { compileGraph, dagGraphType } from '@obversa/runtime';

/** The worker supplies the stored definition and its scratch directory. */
export async function bindRun({ definition, scratchDirectory }) {
  const graph = compileGraph(dagGraphType, definition.graphDefinition.value);
  const { message } = definition.resolvedInputs;
  if (typeof message !== 'string') throw new TypeError('message must be text');
  return {
    graph,
    engines: [],
    nodes: Object.fromEntries(definition.graphDefinition.value.nodes.map(({ id }) => [id, {
      prompt: null,
      scratchDirectory,
      workspace: { mode: 'none', directory: null, allowedPaths: [] },
      trustedCaller: { actor: 'offline-example', provenance: 'local-host' },
      permissions: [],
      policy: {
        inputBytes: 10_000, outputBytes: 10_000, timeoutMs: 5_000,
        teardownGraceMs: 100, memoryBytes: 10_000_000,
        filesChanged: 0, linesChanged: 0, callTokens: null,
      },
      resultContract: null,
      parseResult: null,
      tokenBudget: null,
      retrySafe: false,
      decideAction: async () => ({ kind: 'allow' }),
      runData: async () => {
        await writeFile(join(scratchDirectory, `${id}.txt`), message);
        return { node: id, message };
      },
    }])),
  };
}
