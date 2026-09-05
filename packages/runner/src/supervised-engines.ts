import {
  EngineError, EngineIncompleteResultError, cloneFrozenJson, validateAgentResult,
  validateIncompleteResultEvidence, type AgentResult, type Engine,
  type EngineIncompleteResultEvidence, type JsonObject,
} from '@obversa/engine';
import type { GraphEngineBinding, RunStorageBinding } from '@obversa/runtime';

async function recordable(evidence: EngineIncompleteResultEvidence, storage: RunStorageBinding, runId: string): Promise<JsonObject> {
  const partsArtifact = await storage.artifactStore.write({ namespace: storage.record.namespace, runId }, {
    bytes: Buffer.from(JSON.stringify(evidence.parts)), mediaType: 'application/json',
    purpose: 'runner-engine-parts', contentMode: 'state',
  });
  return cloneFrozenJson({
    partsArtifact,
    usage: { ...evidence.usage },
    requested: { ...evidence.requested },
    effective: { ...evidence.effective },
    ...(evidence.stopReason === undefined ? {} : { stopReason: evidence.stopReason }),
    ...(evidence.transportFailure === undefined ? {} : { transportFailure: { ...evidence.transportFailure } }),
  });
}

export function superviseEngines(
  bindings: readonly GraphEngineBinding[],
  append: (type: 'engine-started' | 'engine-completed' | 'engine-failed', payload: JsonObject) => Promise<void>,
  storage: RunStorageBinding,
  runId: string,
): readonly GraphEngineBinding[] {
  return Object.freeze(bindings.map((binding) => {
    const selected = cloneFrozenJson({ ...binding.selection });
    const engine = Object.freeze<Engine>({
      name: binding.engine.name,
      async run(request, onEvent, signal) {
        const base = cloneFrozenJson({
          attemptId: request.attempt?.attemptId ?? null,
          position: request.attempt?.path[0] ?? null,
          nodeId: request.attempt?.leafId ?? null,
          selected,
        });
        await append('engine-started', base);
        let result: AgentResult;
        let validated: AgentResult;
        try {
          result = await binding.engine.run(request, onEvent, signal);
          validated = validateAgentResult(result);
        } catch (error) {
          try {
            const evidence = error instanceof EngineIncompleteResultError
              ? await recordable(validateIncompleteResultEvidence(error.evidence), storage, runId)
              : {
                usage: { kind: 'unknown' }, partsArtifact: null, requested: selected,
                effective: error instanceof EngineError && error.effective !== undefined ? { ...error.effective } : null,
              };
            await append('engine-failed', cloneFrozenJson({ ...base, ...evidence }));
          } catch (recordError) {
            const cause = new AggregateError([error, recordError], 'Engine failure could not be recorded');
            if (error instanceof EngineIncompleteResultError) {
              const incomplete = new EngineIncompleteResultError('Incomplete engine result could not be recorded', error.evidence);
              incomplete.cause = cause;
              throw incomplete;
            }
            throw cause;
          }
          throw error;
        }
        try {
          const completed = await recordable(validated, storage, runId);
          await append('engine-completed', cloneFrozenJson({ ...base, ...completed }));
        } catch (error) {
          const incomplete = new EngineIncompleteResultError('Completed engine result could not be recorded', validated);
          incomplete.cause = error;
          throw incomplete;
        }
        return result;
      },
    });
    return Object.freeze({ ...binding, target: cloneFrozenJson({ ...binding.target }), selection: selected, engine });
  }));
}
