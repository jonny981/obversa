import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  compileGraph, createApprovalCallbackGate, createGraphExecutor, createStoredCallbackClient,
  dagGraphType, loadRunDefinition, persistRunDefinition, resolveApproval, resolveGraphPlan, writeProofArtifact,
  type ActionDecision, type ApprovalSubjectInput, type ArtifactReference, type CallbackRequest,
  type DagDefinition, type DomainEventEnvelope, type EventStreamRef, type GraphExecutor,
  type GraphNodeBinding, type JsonObject, type JsonValue, type ProofArtifactReference,
  type RunStorageBinding, type Sha256Digest,
} from '@obversa/runtime';
import { createLocalRunStorage } from '@obversa/runtime/storage/local';
import {
  applyTarget, hashBytes, readRecordBuffer, readRecordBytes, readTarget, TargetWriteUncertain, sourcePath, sourceStream, targetPath, targetStream,
  type ActionWitness, type SafeChangeHooks, type SafeChangeInput, type SourceRecord, type TargetRecord,
} from './file-adapter.js';

interface CapturedRecord extends JsonObject { readonly id: string; readonly bytes: string; readonly artifact: ArtifactReference }
interface Capture extends JsonObject {
  readonly sources: readonly CapturedRecord[];
  readonly targets: readonly CapturedRecord[];
  readonly inputHashes: Readonly<Record<string, Sha256Digest>>;
  readonly proof: ProofArtifactReference;
}
interface Intent extends JsonObject {
  readonly actionId: string; readonly nodeId: string; readonly position: string; readonly targetId: string;
  readonly proposalDigest: Sha256Digest; readonly expectedRevision: number; readonly before: ArtifactReference;
  readonly backup: ArtifactReference; readonly afterDigest: Sha256Digest;
  readonly approvalRequestId: string; readonly approvalRequestDigest: string;
}
export interface SafeChangeRun {
  readonly storage: RunStorageBinding;
  readonly executor: GraphExecutor;
  readonly actionPositions: readonly string[];
  readonly verificationPositions: readonly string[];
  readonly approvalPosition: string;
  requestApproval(): Promise<CallbackRequest>;
  /** Scripted fixture approval, called by the host only while execution is stopped. */
  approve(): Promise<void>;
}
const policy = {
  schemaVersion: 1, maxEventPayloadBytes: 2_000_000, maxAppendBatchBytes: 4_000_000,
  maxArtifactBytes: 2_000_000, maxTotalArtifactBytesPerRun: 32_000_000,
  retention: 'until-run-delete', sensitiveContent: { marked: 'reject', exact: 'reject', freeText: 'redact-before-hash' },
} as const;
const kinds = new Set(['document', 'current-record', 'discussion-comment', 'historical-entry']);
const decode = (bytes: Uint8Array): string => new TextDecoder('utf8', { fatal: true }).decode(bytes);

export async function openSafeChangeRun(options: {
  readonly directory: string; readonly runId: string; readonly input?: SafeChangeInput; readonly hooks?: SafeChangeHooks;
}): Promise<SafeChangeRun> {
  await mkdir(options.directory, { recursive: true });
  const directory = await realpath(options.directory);
  const { runId } = options;
  const storage = createLocalRunStorage({ directory: join(directory, 'storage'), namespace: 'safe-change', policy });
  const runStream = { namespace: storage.record.namespace, streamId: runId };
  const scope = { namespace: storage.record.namespace, runId };
  const events = async (stream: EventStreamRef): Promise<DomainEventEnvelope[]> => {
    const values: DomainEventEnvelope[] = [];
    for await (const event of storage.eventStore.read(stream)) values.push(event);
    return values;
  };
  const existing = await events(runStream);
  const input = JSON.parse(JSON.stringify(existing.length
    ? (await loadRunDefinition(storage, runId)).record.payload.definition.resolvedInputs.input : options.input)) as SafeChangeInput;
  if (!input || input.sourceIds.length < 1 || input.sourceIds.length > 8 || input.destinations.length < 1 || input.destinations.length > 4) {
    throw new Error('Safe-change requires 1–8 sources and 1–4 destinations');
  }
  if (new Set(input.sourceIds).size !== input.sourceIds.length || new Set(input.destinations.map((target) => target.id)).size !== input.destinations.length) {
    throw new Error('Safe-change source and destination IDs must be unique');
  }
  if (existing.length && options.input && !isDeepStrictEqual(input, options.input)) throw new Error('Stored safe-change input differs');
  if (input.sourceIds.some((id) => sourceStream(id).streamId === runId) || input.destinations.some((target) => targetStream(target.id).streamId === runId)) {
    throw new Error('Safe-change run stream must differ from every source and target stream');
  }
  const writePermission = { name: 'workspace.write', scope: { paths: input.destinations.map((target) => targetPath(directory, target.id)) } };
  const actionNames = input.destinations.map((_, index) => `apply-${index + 1}`);
  const names = ['capture', 'map', 'propose', 'approval', 'backup', ...actionNames.flatMap((name) => [name, `verify-${name}`]), 'retention'];
  const definition: DagDefinition = {
    id: 'safe-change', definitionVersion: 1,
    data: { globalConcurrency: 1, keyedConcurrency: {}, stopOnError: true, retryCapPerNode: 0 },
    nodes: names.map((id) => ({ id, data: { kind: 'required', key: null } })),
    edges: names.slice(1).map((name, index) => ({ id: `edge-${index}`, source: names[index]!, target: name, data: {} })),
  };
  const graph = compileGraph(dagGraphType, definition);
  if (existing.length === 0) {
    const identity = { source: 'example:safe-change', version: '1.0.0', digest: hashBytes('safe-change-recipe-v1') };
    const resolvedPlan = resolveGraphPlan(graph.describe(), { package: identity, admission: { package: identity, permissions: [writePermission] }, executionLanes: [] });
    await persistRunDefinition(storage, { runId, eventId: `${runId}-started`, timestamp: new Date().toISOString(), graphDefinition: graph.definition,
      resolvedPlan, resolvedInputs: { input }, workspaceBinding: null, hostBinding: null });
  }
  const completed = async <T extends JsonValue>(nodeId: string): Promise<T> => {
    const event = (await events(runStream)).find((entry) => entry.type === 'graph:node-completed' && (entry.payload as JsonObject).nodeId === nodeId);
    if (!event) throw new Error(`No completed ${nodeId} attempt`);
    return (event.payload as JsonObject).result as T;
  };
  const append = async (stream: EventStreamRef, type: string, key: string, payload: JsonObject): Promise<void> => {
    const history = await events(stream);
    const eventId = hashBytes(`${runId}:${type}:${key}`);
    const previous = history.find((event) => event.eventId === eventId);
    if (previous) {
      if (previous.type !== type || previous.version !== 1 || previous.correlationId !== runId || !isDeepStrictEqual(previous.payload, payload)) throw new Error('Safe-change event identity has different content');
      return;
    }
    await storage.eventStore.append(stream, history.at(-1)?.revision ?? 0, [{ eventId, type, version: 1,
      timestamp: new Date().toISOString(), correlationId: runId, causationId: null, payload }]);
  };
  const artifact = (bytes: string | Uint8Array, purpose: string): Promise<ArtifactReference> => storage.artifactStore.write(scope, {
    bytes: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes,
    mediaType: typeof bytes === 'string' ? 'application/json' : 'application/octet-stream', purpose, contentMode: 'exact',
  });
  const readArtifact = async (ref: ArtifactReference): Promise<string> => decode(await storage.artifactStore.read(scope, ref));
  const capture = (): Promise<Capture> => completed<Capture>('capture');
  const proposal = (): Promise<JsonObject> => completed<JsonObject>('propose');
  const backup = (): Promise<ArtifactReference> => completed<ArtifactReference>('backup');
  const approval = async (): Promise<{ request: CallbackRequest; subject: ApprovalSubjectInput }> => {
    const captured = await capture();
    const proposed = await proposal();
    const subject: ApprovalSubjectInput = { workspaceAnchor: null, inputArtifactHashes: captured.inputHashes,
      proofScope: { kind: 'safe-change', protectedFacts: 'complete-source-records' }, proofArtifact: captured.proof,
      proposedOutput: new TextEncoder().encode(JSON.stringify(proposed)), effectivePermissions: [writePermission] };
    const request = createApprovalCallbackGate({ gateId: 'safe-change-approval', gateVersion: 1,
      decisionText: 'Apply the exact scripted safe-change proposal?', responseSchema: { type: 'object', properties: { kind: { type: 'string' } }, required: ['kind'] },
      input: { runId } }, subject);
    return { request, subject };
  };
  const approved = async (): Promise<ActionDecision> => {
    const { request, subject } = await approval();
    return resolveApproval(storage, runId, { request, ...subject });
  };
  const validateMapping = async (): Promise<void> => {
    const captured = await capture();
    if (input.mappings.length !== captured.sources.length) throw new Error('Every protected source record requires exactly one mapping');
    for (const source of captured.sources) {
      const mappings = input.mappings.filter((mapping) => mapping.sourceId === source.id);
      if (mappings.length !== 1) throw new Error(`Missing or duplicate mapping for ${source.id}`);
      const destination = input.destinations.find((target) => target.id === mappings[0]!.targetId);
      if (!destination) throw new Error(`Unknown destination for ${source.id}`);
      const records: unknown = JSON.parse(destination.content);
      if (!Array.isArray(records) || !records.some((record) => isDeepStrictEqual(record, JSON.parse(source.bytes)))) {
        throw new Error(`Protected record ${source.id} lost metadata or body bytes`);
      }
      const target = await readTarget(directory, destination.id);
      if (!target.active) throw new Error(`Destination ${destination.id} is inactive`);
    }
  };
  const verifyBackup = async (): Promise<ArtifactReference> => {
    const captured = await capture();
    const ref = await backup();
    const expected = { sources: captured.sources.map(({ id, bytes }) => ({ id, bytes })), targets: captured.targets.map(({ id, bytes }) => ({ id, bytes })) };
    if (await readArtifact(ref) !== JSON.stringify(expected)) throw new Error('Complete backup does not match the captured records');
    return ref;
  };
  const recheck = async (): Promise<void> => {
    if ((await approved()).kind !== 'allow') throw new Error('Approval no longer permits these bytes');
    const captured = await capture();
    for (const source of captured.sources) {
      if (hashBytes(await readRecordBytes(sourcePath(directory, source.id))) !== captured.inputHashes[source.id]) throw new Error(`Source ${source.id} changed after capture`);
    }
    await verifyBackup();
    await validateMapping();
  };
  const originalAttempt = async (nodeId: string): Promise<{ actionId: string; position: string }> => {
    const started = (await events(runStream)).find((event) => event.type === 'graph:node-attempt-started'
      && ((event.payload as JsonObject).identity as JsonObject).nodeId === nodeId);
    if (!started) throw new Error('Safe-change action has no recorded original attempt');
    const identity = (started.payload as JsonObject).identity as JsonObject;
    return { actionId: identity.attemptId as string, position: identity.position as string };
  };
  const journal = async (targetId: string, actionId: string) => (await events(targetStream(targetId)))
    .filter((event) => (event.payload as JsonObject).actionId === actionId);
  const wait = (reason: string): ActionDecision => ({ kind: 'wait', reason, request: { kind: 'safe-change-reconciliation', runId } });
  const expectedAfter = async (intent: Intent): Promise<TargetRecord> => {
    const before = JSON.parse(await readArtifact(intent.before)) as TargetRecord;
    const destination = input.destinations.find((value) => value.id === intent.targetId)!;
    const witness: ActionWitness = { actionId: intent.actionId, proposalDigest: intent.proposalDigest, beforeDigest: intent.before.digest, afterDigest: intent.afterDigest };
    return { ...before, revision: intent.expectedRevision + 1, content: destination.content, lastAction: witness };
  };
  const inspect = async (intent: Intent): Promise<JsonObject> => {
    const history = await journal(intent.targetId, intent.actionId);
    const previous = history.find((event) => event.type === 'safe-change:result');
    const bytes = await readRecordBuffer(targetPath(directory, intent.targetId));
    const matches = bytes.equals(Buffer.from(JSON.stringify(await expectedAfter(intent))));
    if (previous && ((previous.payload as JsonObject).outcome === 'mismatch' || matches)) return previous.payload as JsonObject;
    const result = { actionId: intent.actionId, targetId: intent.targetId, outcome: matches ? 'verified' : 'mismatch',
      before: intent.before, after: await artifact(bytes, 'safe-change-readback'), backup: intent.backup,
      protectedFacts: matches ? input.mappings.filter((mapping) => mapping.targetId === intent.targetId).length : 0 };
    await append(targetStream(intent.targetId), 'safe-change:result', previous ? `${intent.actionId}:mismatch` : intent.actionId, result);
    return result;
  };
  const decisionForAction = async (nodeId: string, targetId: string): Promise<ActionDecision> => {
    const { actionId } = await originalAttempt(nodeId);
    const history = await journal(targetId, actionId);
    if (history.some((event) => (event.payload as JsonObject).outcome === 'mismatch')) return wait('Readback mismatch requires a person to decide');
    const intent = history.find((event) => event.type === 'safe-change:intent')?.payload as Intent | undefined;
    if (!intent) return approved();
    const { request } = await approval();
    if (intent.approvalRequestId !== request.requestId || intent.approvalRequestDigest !== request.digest) {
      return wait('Recorded action approval request differs from the current request');
    }
    const bytes = await readRecordBuffer(targetPath(directory, targetId));
    if (!bytes.equals(Buffer.from(JSON.stringify(await expectedAfter(intent))))) {
      await inspect(intent);
      return wait('Uncertain action has no matching target witness; a person must decide');
    }
    return { kind: 'allow' };
  };
  const binding = (runData: NonNullable<GraphNodeBinding['runData']>, decideAction: GraphNodeBinding['decideAction'] = async () => ({ kind: 'allow' })): GraphNodeBinding => ({
    prompt: null, scratchDirectory: directory, workspace: { mode: 'none', directory: null, allowedPaths: [] }, trustedCaller: { kind: 'scripted-safe-change-fixture' }, permissions: [],
    policy: { inputBytes: 2_000_000, outputBytes: 2_000_000, timeoutMs: 30_000, teardownGraceMs: 100, memoryBytes: 64_000_000, filesChanged: 0, linesChanged: 0, callTokens: null },
    resultContract: null, runData, parseResult: null, tokenBudget: null, retrySafe: false, decideAction,
  });
  const nodes: Record<string, GraphNodeBinding> = {
    capture: binding(async () => {
      const sources: CapturedRecord[] = [];
      const targets: CapturedRecord[] = [];
      for (const sourceId of input.sourceIds) {
        const bytes = await readRecordBytes(sourcePath(directory, sourceId));
        const record = JSON.parse(bytes) as SourceRecord;
        if (record.id !== sourceId || !kinds.has(record.kind) || typeof record.body !== 'string' || !record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata)) throw new Error(`Invalid source ${sourceId}`);
        const ref = await artifact(bytes, 'safe-change-source');
        sources.push({ id: sourceId, bytes, artifact: ref });
        await append(sourceStream(sourceId), 'safe-change:source-recorded', sourceId, { sourceId, record, artifact: ref });
      }
      for (const destination of input.destinations) {
        await readTarget(directory, destination.id);
        const bytes = await readRecordBytes(targetPath(directory, destination.id));
        targets.push({ id: destination.id, bytes, artifact: await artifact(bytes, 'safe-change-before') });
      }
      const inputHashes = Object.fromEntries(sources.map((source) => [source.id, source.artifact.digest]));
      const proof = await writeProofArtifact(storage.artifactStore, scope, { sources, inputHashes, protectedFacts: 'complete-source-records' });
      return { sources, targets, inputHashes, proof };
    }),
    map: binding(async () => { await validateMapping(); return { mappings: input.mappings }; }),
    propose: binding(async () => {
      await validateMapping();
      return { destinations: input.destinations, mappings: input.mappings, inputHashes: (await capture()).inputHashes };
    }),
    approval: binding(async () => ({ approved: true }), approved),
    backup: binding(async () => {
      const captured = await capture();
      const bytes = JSON.stringify({ sources: captured.sources.map(({ id, bytes }) => ({ id, bytes })), targets: captured.targets.map(({ id, bytes }) => ({ id, bytes })) });
      const ref = await artifact(bytes, 'safe-change-backup');
      if (await readArtifact(ref) !== bytes) throw new Error('Backup verification failed');
      return ref;
    }),
    retention: binding(async () => {
      await validateMapping();
      for (const destination of input.destinations) {
        const actual = JSON.parse(await readRecordBytes(targetPath(directory, destination.id))) as TargetRecord;
        if (actual.content !== destination.content) throw new Error('Final protected-fact retention failed');
      }
      return { protectedFacts: input.sourceIds.length, lostProtectedFacts: 0, scriptedProposalAndReview: true };
    }),
  };
  for (const [index, destination] of input.destinations.entries()) {
    const nodeId = actionNames[index]!;
    nodes[nodeId] = { ...binding(async () => {
      const attempt = await originalAttempt(nodeId);
      const history = await journal(destination.id, attempt.actionId);
      let intent = history.find((event) => event.type === 'safe-change:intent')?.payload as Intent | undefined;
      if (!intent) {
        const captured = await capture();
        const { request } = await approval();
        intent = { ...attempt, nodeId, targetId: destination.id, proposalDigest: hashBytes(JSON.stringify(await proposal())), approvalRequestId: request.requestId, approvalRequestDigest: request.digest, expectedRevision: destination.expectedRevision,
          before: captured.targets.find((target) => target.id === destination.id)!.artifact, backup: await verifyBackup(), afterDigest: hashBytes(destination.content) };
        await append(targetStream(destination.id), 'safe-change:intent', attempt.actionId, intent);
        const expected = await expectedAfter(intent);
        try {
          await applyTarget(directory, destination, expected.lastAction!, recheck, options.hooks ?? {});
        } catch (error) {
          if (!(error instanceof TargetWriteUncertain)) throw error;
          // An outward write with a lost response is reconciled through exact readback.
        }
      }
      return inspect(intent);
    }, () => decisionForAction(nodeId, destination.id)), permissions: ['workspace.write'] };
    nodes[`verify-${nodeId}`] = binding(async () => ({ verified: true }), async () => {
      const { actionId } = await originalAttempt(nodeId);
      const history = await journal(destination.id, actionId);
      if (history.some((event) => (event.payload as JsonObject).outcome === 'mismatch')) return wait('Readback mismatch requires a person to decide');
      const result = history.find((event) => event.type === 'safe-change:result')?.payload as JsonObject | undefined;
      return result?.outcome === 'verified' ? { kind: 'allow' } : wait('Readback mismatch requires a person to decide');
    });
  }
  const executor = await createGraphExecutor({ runId, graph, storage, nodes, engines: [] });
  const requestApproval = async (): Promise<CallbackRequest> => {
    const { request, subject } = await approval();
    const callbacks = await createStoredCallbackClient(storage, runId);
    if ((await callbacks.history(request.requestId)).length === 0) await callbacks.post(request, subject);
    return request;
  };
  return { storage, executor, approvalPosition: 'dag/approval/1', actionPositions: actionNames.map((name) => `dag/${name}/1`),
    verificationPositions: actionNames.map((name) => `dag/verify-${name}/1`), requestApproval,
    approve: async () => {
      const request = await requestApproval();
      if ((await approved()).kind === 'allow') return;
      const callbacks = await createStoredCallbackClient(storage, runId);
      const claim = await callbacks.claim(request.requestId, 'scripted-reviewer');
      if (!claim.ok) throw new Error('Scripted fixture approval was not claimed');
      const submitted = await callbacks.submit(request.requestId, claim.claimToken, 'scripted-reviewer', request.digest, { kind: 'allow' }, { kind: 'scripted-fixture' });
      if (!submitted.ok) throw new Error(`Scripted fixture approval refused: ${submitted.reason}`);
    } };
}
