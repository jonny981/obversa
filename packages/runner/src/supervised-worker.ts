import { pathToFileURL } from 'node:url';

import { inspectOwnedProcessTree } from '@obversa/engine/command';

import { createLocalRunStorage } from '@obversa/runtime/storage/local';
import { createGraphExecutor, loadRunDefinition, type Sha256Digest } from '@obversa/runtime';
import {
  hostModuleDigest, readGraphPosition, resolveHostModule, SupervisedRunError, supervisionWriter,
  type SupervisedHostRecord,
} from './supervised-record.js';
import type { SupervisedRunBindings, SupervisedWorkerInput } from './supervised-run.js';
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
try {
  const loaded = await loadRunDefinition(storage, input.runId);
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
  });
  const signal = new AbortController().signal;
  const requestedPause = input.resume === undefined ? undefined
    : await readGraphPosition(storage, input.runId, input.resume.position);
  let result = input.resume !== undefined && requestedPause?.type === 'graph:node-paused'
    && requestedPause.eventId !== input.resume.pauseEventId
    ? {
      kind: 'pause' as const, code: 'RESUME_EVENT_MISMATCH' as const,
      reason: `Resume expected pause event "${input.resume.pauseEventId}" but found "${requestedPause.eventId}".`,
    }
    : input.resume !== undefined && requestedPause?.type === 'graph:node-paused'
    && requestedPause.eventId === input.resume.pauseEventId
    ? await executor.resume(input.resume.position, signal) : await executor.run(signal);
  while (result.kind === 'waiting') {
    const position = result.positions[0];
    if (position === undefined) throw new SupervisedRunError('WORKER_PROTOCOL', 'The executor is waiting without an unfinished position.');
    result = await executor.resume(position, signal);
  }
  await append('worker-result', result.kind === 'complete' ? {
    kind: 'complete',
    outputArtifact: await storage.artifactStore.write({ namespace: storage.record.namespace, runId: input.runId }, {
      bytes: Buffer.from(JSON.stringify(result.output)), mediaType: 'application/json',
      purpose: 'runner-output', contentMode: 'state',
    }),
  } : { ...result });
} catch (error) {
  await append('worker-result', {
    kind: 'fail',
    code: error instanceof SupervisedRunError ? error.code : 'WORKER_ERROR',
    message: error instanceof Error ? error.message : 'The worker failed.',
  });
}
// The watchdog owns teardown. A host's open handles must not delay it after
// the worker has durably recorded its result.
process.exit(0);
