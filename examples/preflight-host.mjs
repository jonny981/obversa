import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

import { compileGraph, dagGraphType, EngineError } from '@obversa/runtime';

/**
 * Bind the stored graph to one scripted local engine.
 * The answers and token counts are local fixtures, not model-service measurements.
 *
 * @param {import('@obversa/runner').SupervisedHostContext} context
 * @returns {Promise<import('@obversa/runner').SupervisedRunBindings>}
 */
export async function bindRun(context) {
  const { definition, scratchDirectory } = context;
  const graphDefinition = /** @type {import('@obversa/runtime').DagDefinition} */ (
    definition.graphDefinition.value
  );
  const graph = compileGraph(dagGraphType, graphDefinition);
  const { controlFile, callsFile } = definition.resolvedInputs;
  if (typeof controlFile !== 'string' || typeof callsFile !== 'string') {
    throw new TypeError('controlFile and callsFile must be paths');
  }
  const callLogPath = callsFile;
  const lane = graphDefinition.nodes[0]?.data.lane;
  if (lane === undefined) throw new TypeError('the example graph must declare one engine lane');
  const target = lane.requested;
  const selection = {
    adapter: target.adapter,
    adapterVersion: '1.0.0',
    provider: target.provider,
    modelFamily: target.modelFamily,
    model: target.model,
    executable: null,
    capabilities: target.tools,
  };
  /** @param {string} value */
  async function mark(value) {
    await appendFile(callLogPath, `${value}\n`);
  }
  /** @type {import('@obversa/runtime').Engine} */
  const engine = {
    name: target.adapter,
    async admit(request, signal, expected) {
      assert.equal('prompt' in request, false);
      if (signal.aborted) {
        throw new EngineError({ kind: 'aborted', message: 'Local static check was aborted.' });
      }
      await mark('static');
      if (expected !== undefined && !isDeepStrictEqual(expected, selection)) {
        throw new EngineError({ kind: 'invalid-config', message: 'Saved local identity changed.' });
      }
      return selection;
    },
    async run(request, _onEvent, signal) {
      if (signal.aborted) {
        throw new EngineError({ kind: 'aborted', message: 'Local engine call was aborted.' });
      }
      if (request.purpose === 'preflight') {
        assert.deepEqual(request.tools, []);
        assert.deepEqual(request.allowedTools, []);
        assert.equal(request.workspaceMode, 'none');
        assert.equal(request.leaf, true);
        const ready = (await readFile(controlFile, 'utf8')).trim() === 'ready';
        await mark(`live:${ready ? 'ready' : 'not-ready'}`);
        if (!ready) {
          throw new EngineError({ kind: 'transient', message: 'Local check is not ready.' });
        }
        return {
          parts: [{ kind: 'assistant', text: 'ok', final: true }],
          usage: { kind: 'reported', inputTokens: 1, outputTokens: 1 },
          requested: selection,
          effective: selection,
        };
      }
      await mark('ordinary');
      return {
        parts: [{ kind: 'structured', value: { checked: 'offline' }, final: true }],
        usage: { kind: 'reported', inputTokens: 2, outputTokens: 1 },
        requested: selection,
        effective: selection,
      };
    },
  };

  return {
    graph,
    engines: [{ target, selection, engine, hardTokenLimitEnforceable: false }],
    nodes: {
      check: {
        prompt: () => 'Return the scripted offline result.',
        scratchDirectory,
        workspace: { mode: 'none', directory: null, allowedPaths: [] },
        trustedCaller: { actor: 'preflight-example', provenance: 'local-script' },
        permissions: [],
        policy: {
          inputBytes: 10_000,
          outputBytes: 10_000,
          timeoutMs: 5_000,
          teardownGraceMs: 100,
          memoryBytes: 10_000_000,
          filesChanged: 0,
          linesChanged: 0,
          callTokens: null,
        },
        resultContract: null,
        runData: null,
        parseResult: null,
        tokenBudget: null,
        retrySafe: true,
        decideAction: async () => ({ kind: 'allow' }),
      },
    },
  };
}
