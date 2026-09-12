import { pathToFileURL } from 'node:url';

import { inspectOwnedProcessTree } from '@obversa/engine/command';
import { createLocalRunStorage } from '@obversa/runtime/storage/local';
import {
  createGraphExecutor, GraphExecutionError, loadRunDefinition, readRunPreflight, validateDomainEventId,
  type RunPreflightState, type Sha256Digest,
} from '@obversa/runtime';
import {
  hostModuleDigest, readGraphPosition, resolveHostModule, SupervisedRunError, supervisionWriter,
  type SupervisedHostRecord,
} from './supervised-record.js';
import type { SupervisedRunBindings, SupervisedRunResult, SupervisedWorkerInput } from './supervised-run.js';
import { superviseEngines } from './supervised-engines.js';

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as SupervisedWorkerInput;
const storage = createLocalRunStorage(input.storage);
const append = supervisionWriter(storage, input.runId);
const processes = await inspectOwnedProcessTree({
  rootPid: process.pid, rootProcessGroupId: process.pid,
  attemptId: process.env.OBVERSA_ATTEMPT_ID as Sha256Digest,
});
const identity = processes.find((item) => item.pid === process.pid);
if (identity === undefined) throw new SupervisedRunError('PROCESS_INSPECTION', 'The worker could not inspect its process identity.');
await append('worker-started', { process: identity });

async function preflightState(): Promise<RunPreflightState> {
  try { return await readRunPreflight(storage, input.runId); }
  catch (cause) { throw new SupervisedRunError('RUN_STORAGE', 'Preflight state could not be read.', { cause }); }
}

function mismatch(expected: string, state: RunPreflightState): Extract<SupervisedRunResult, { kind: 'pause' }> {
  const current = state.pause?.preflightEventId;
  return {
    kind: 'pause', code: 'RESUME_EVENT_MISMATCH',
    reason: `Resume expected preflight pause event "${expected}" but found "${current ?? '<none>'}".`,
    ...(current === undefined ? {} : { preflightEventId: current }),
  };
}

async function runWorker(): Promise<SupervisedRunResult> {
  let expectedPreflightEventId: string | undefined;
  const resume: unknown = input.resume;
  if (resume !== null && typeof resume === 'object' && 'preflightEventId' in resume) {
    const id = resume.preflightEventId;
    if (Array.isArray(resume) || !Object.hasOwn(resume, 'preflightEventId')
      || Object.getOwnPropertyNames(resume).length !== 1 || Object.getOwnPropertySymbols(resume).length !== 0 || 'position' in resume || 'pauseEventId' in resume) {
      throw new SupervisedRunError('INVALID_OPTIONS', 'Worker preflight resume requires only one own preflightEventId.');
    }
    try { expectedPreflightEventId = validateDomainEventId(id, '/preflightEventId'); }
    catch (cause) {
      throw new SupervisedRunError('INVALID_OPTIONS', 'Worker preflight resume requires only one own preflightEventId.', { cause });
    }
  }
  const loaded = await loadRunDefinition(storage, input.runId);
  const preflight = loaded.resolvedPlan.plan.preflight !== undefined || expectedPreflightEventId !== undefined
    ? await preflightState() : undefined;
  if (preflight?.pause !== undefined && preflight.pause !== null) {
    if (expectedPreflightEventId === undefined) return preflight.pause;
    if (preflight.pause.preflightEventId !== expectedPreflightEventId) return mismatch(expectedPreflightEventId, preflight);
  } else if (expectedPreflightEventId !== undefined && preflight!.resumedPreflightEventId !== expectedPreflightEventId) {
    return mismatch(expectedPreflightEventId, preflight!);
  }
  if (preflight?.unfinishedProbeEventId !== undefined && preflight.unfinishedProbeEventId !== null) {
    throw new SupervisedRunError('RUN_NOT_PAUSED', 'Unfinished preflight requires verified watchdog cleanup.');
  }
  const graphResume = expectedPreflightEventId === undefined ? input.resume as {
    readonly position: string; readonly pauseEventId: string;
  } | undefined : undefined;
  const requestedPause = graphResume === undefined ? undefined
    : await readGraphPosition(storage, input.runId, graphResume.position);
  if (graphResume !== undefined && requestedPause?.type === 'graph:node-paused'
    && requestedPause.eventId !== graphResume.pauseEventId) {
    throw new SupervisedRunError('RESUME_EVENT_MISMATCH',
      `Resume expected pause event "${graphResume.pauseEventId}" but found "${requestedPause.eventId}".`);
  }
  if (loaded.hostBindingBytes === null) {
    throw new SupervisedRunError('HOST_MODULE', 'The run has no stored host module.');
  }
  const host = JSON.parse(Buffer.from(loaded.hostBindingBytes).toString('utf8')) as SupervisedHostRecord;
  const modulePath = resolveHostModule(input.runRoot, host.module);
  if (await hostModuleDigest(modulePath) !== host.digest) {
    throw new SupervisedRunError('HOST_MODULE_CHANGED', 'The host module differs from its stored digest.');
  }
  const hostModule = await import(pathToFileURL(modulePath).href);
  if (await hostModuleDigest(modulePath) !== host.digest) {
    throw new SupervisedRunError('HOST_MODULE_CHANGED', 'The host module changed while it was loaded.');
  }
  if (typeof hostModule.bindRun !== 'function') {
    throw new SupervisedRunError('HOST_MODULE', 'The host module must export bindRun.');
  }
  const bindings: SupervisedRunBindings = await hostModule.bindRun({
    definition: loaded.record.payload.definition, scratchDirectory: input.scratchDirectory,
  });
  await append('bound', { timeouts: Object.fromEntries(Object.entries(bindings.nodes).map(([id, node]) => [id, node.policy.timeoutMs])) });
  const eventStore = {
    read: storage.eventStore.read.bind(storage.eventStore),
    preflightAppend: storage.eventStore.preflightAppend.bind(storage.eventStore),
    append: async (...args: Parameters<typeof storage.eventStore.append>) => {
      const [stream, , batch] = args;
      const next = batch.filter((event) => event.type === 'graph:node-dispatched').length;
      if (next > 0) {
        let count = next;
        for await (const event of storage.eventStore.read(stream)) {
          if (event.type === 'graph:node-dispatched') count += 1;
        }
        if (count > host.limits.maxDispatches) {
          throw new SupervisedRunError('BUDGET_STOP', 'The run dispatch budget is exhausted.');
        }
      }
      return await storage.eventStore.append(...args);
    },
  };
  const nodes = Object.fromEntries(Object.entries(bindings.nodes).map(([nodeId, binding]) => [nodeId, {
    ...binding,
    decideAction: async () => {
      const decision = await binding.decideAction();
      if (decision.kind === 'allow') return decision;
      await append(decision.kind === 'wait' ? 'action-waiting' : 'action-denied', {
        nodeId, trustedCaller: binding.trustedCaller, permissions: binding.permissions,
        decision, reason: decision.reason,
      });
      return decision;
    },
  }]));
  const executor = await createGraphExecutor({
    ...bindings, nodes, engines: superviseEngines(bindings.engines, append, storage, input.runId),
    storage: { ...storage, eventStore }, runId: input.runId,
    preflightScratchDirectory: input.scratchDirectory,
  });
  const signal = new AbortController().signal;
  let result: Awaited<ReturnType<typeof executor.run>>;
  try {
    if (expectedPreflightEventId !== undefined && preflight!.pause !== null) {
      result = await executor.resume({ preflightEventId: expectedPreflightEventId }, signal);
    } else if (graphResume !== undefined && requestedPause?.type === 'graph:node-paused'
      && requestedPause.eventId === graphResume.pauseEventId) {
      result = await executor.resume(graphResume.position, signal);
    } else {
      result = await executor.run(signal);
    }
  } catch (error) {
    if (error instanceof GraphExecutionError && error.code === 'RESUME_EVENT_MISMATCH'
      && expectedPreflightEventId !== undefined) {
      return mismatch(expectedPreflightEventId, await preflightState());
    }
    throw error;
  }
  while (result.kind === 'waiting') {
    const position = result.positions[0];
    if (position === undefined) throw new SupervisedRunError('WORKER_PROTOCOL', 'The executor is waiting without an unfinished position.');
    result = await executor.resume(position, signal);
  }
  return result;
}

try {
  const result = await runWorker();
  await append('worker-result', result.kind === 'complete' ? {
    kind: 'complete',
    outputArtifact: await storage.artifactStore.write({ namespace: storage.record.namespace, runId: input.runId }, {
      bytes: Buffer.from(JSON.stringify(result.output)), mediaType: 'application/json',
      purpose: 'runner-output', contentMode: 'state',
    }),
  } : { ...result });
} catch (error) {
  await append('worker-result', error instanceof SupervisedRunError && error.code === 'RESUME_EVENT_MISMATCH'
    ? { kind: 'pause', code: error.code, reason: error.message }
    : {
      kind: 'fail',
      code: error instanceof SupervisedRunError ? error.code : 'WORKER_ERROR',
      message: error instanceof Error ? error.message : 'The worker failed.',
    });
}
// The watchdog owns teardown. A host's open handles must not delay it after
// the worker has durably recorded its result.
process.exit(0);
