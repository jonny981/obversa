import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { compileGraph, convergence, dagGraphType } from '@obversa/runtime';
import { createLocalRunStorage } from '@obversa/runtime/storage/local';

export async function bindRun({ definition, scratchDirectory }) {
  const { form, boundary, storage } = definition.resolvedInputs;
  const graph = compileGraph(form === 'dag' ? dagGraphType : convergence, definition.graphDefinition.value);
  const store = createLocalRunStorage(storage).eventStore;
  const prototype = Object.getPrototypeOf(store);
  const append = prototype.append;
  const effectsPath = join(scratchDirectory, 'effects.jsonl');
  const crashPath = join(scratchDirectory, 'crash.json');
  const expectedTypes = [
    ['graph:run-started'],
    ['graph:run-started', 'graph:node-dispatched'],
    ['graph:run-started', 'graph:node-dispatched', 'graph:node-attempt-started'],
    ['graph:run-started', 'graph:node-dispatched', 'graph:node-attempt-started', 'graph:node-completed'],
  ][boundary - 1];

  async function crashOnce(stream) {
    try { await readFile(crashPath); return; } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const types = [];
    for await (const event of store.read(stream)) types.push(event.type);
    const effects = (await readFile(effectsPath, 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    })).trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.deepEqual(types, expectedTypes);
    assert.equal(effects.length, boundary < 3 ? 0 : 1);
    await writeFile(crashPath, JSON.stringify({ boundary, pid: process.pid, types, effects }), { flag: 'wx' });
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  }

  // Wrap real persistence only in this disposable worker; never replace its writes.
  prototype.append = async function (stream, revision, batch) {
    const target = boundary < 3 ? 'graph:node-dispatched' : 'graph:node-completed';
    const matches = stream.streamId === definition.runId && batch.some((event) => event.type === target);
    if (matches && (boundary === 1 || boundary === 3)) await crashOnce(stream);
    const result = await append.call(this, stream, revision, batch);
    if (matches && (boundary === 2 || boundary === 4)) await crashOnce(stream);
    return result;
  };

  const evidence = {
    inputHashes: { draft: 'fixed-draft' }, workspaceFingerprint: 'fixed-workspace',
    proofArtifactDigest: `sha256:${'a'.repeat(64)}`,
  };
  return {
    graph,
    engines: [],
    nodes: Object.fromEntries(definition.graphDefinition.value.nodes.map(({ id }) => [id, {
      prompt: null, scratchDirectory,
      workspace: { mode: 'none', directory: null, allowedPaths: [] },
      trustedCaller: { actor: 'crash-fixture', provenance: 'local-test' }, permissions: [],
      policy: {
        inputBytes: 10_000, outputBytes: 10_000, timeoutMs: 5_000,
        teardownGraceMs: 100, memoryBytes: 10_000_000,
        filesChanged: 0, linesChanged: 0, callTokens: null,
      },
      resultContract: null, parseResult: null, tokenBudget: null, retrySafe: false,
      decideAction: async () => ({ kind: 'allow' }),
      runData: async () => {
        await appendFile(effectsPath, `${JSON.stringify({ nodeId: id, pid: process.pid })}\n`);
        if (id === 'evaluator') return { gateMet: true, ...evidence };
        if (id === 'seat') return { verdict: 'pass', confidence: 1, ...evidence };
        return { node: id };
      },
    }])),
  };
}
