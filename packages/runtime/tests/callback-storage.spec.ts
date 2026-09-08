import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createApprovalCallbackGate,
  prepareApprovalRecord,
  resolveApproval,
  snapshotApprovalSubject,
  type ApprovalSubjectInput,
} from '../src/callback/approval.js';
import { createStoredCallbackClient } from '../src/callback/stored-client.js';
import { createCallbackGate } from '../src/callback/gate.js';
import type { DomainEventEnvelope } from '../src/events/envelope.js';
import type { DomainEventBatch } from '../src/events/store.js';
import type { JsonObject, Sha256Digest } from '../src/graph/value.js';
import { compileGraph } from '../src/graph/type.js';
import { dag } from '../src/graph-types/dag.js';
import { resolveGraphPlan } from '../src/graph/plan.js';
import {
  loadRunDefinition,
  persistRunDefinition,
  type RunStorageBinding,
} from '../src/runtime/run-definition.js';
import { StorageError } from '../src/storage/error.js';
import { createLocalRunStorage } from '../src/storage/local.js';

// Real work: these tests write files to temporary directories on disk, so
// this file declares its own time limit; the suite default is a hang guard,
// not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storedRun() {
  const root = await mkdtemp(join(tmpdir(), 'obversa-callback-storage-'));
  roots.push(root);
  const graph = compileGraph(dag, {
    id: 'callback-storage',
    definitionVersion: 1,
    data: {
      globalConcurrency: 1,
      keyedConcurrency: {},
      stopOnError: true,
      retryCapPerNode: 0,
    },
    nodes: [{ id: 'approval', data: { kind: 'required', key: null } }],
    edges: [],
  });
  const packageIdentity = {
    source: 'npm:@example/callback-storage',
    version: '1.0.0',
    digest: `sha256:${'1'.repeat(64)}` as const,
  };
  const storage = createLocalRunStorage({
    directory: join(root, 'storage'),
    namespace: 'callback-tests',
    policy: {
      schemaVersion: 1,
      maxEventPayloadBytes: 64_000,
      maxAppendBatchBytes: 128_000,
      maxArtifactBytes: 1_000_000,
      maxTotalArtifactBytesPerRun: 4_000_000,
      retention: 'until-run-delete',
      sensitiveContent: {
        marked: 'reject',
        exact: 'reject',
        freeText: 'redact-before-hash',
      },
    },
  });
  const runId = 'callback-run';
  await persistRunDefinition(storage, {
    runId,
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    graphDefinition: graph.definition,
    resolvedPlan: resolveGraphPlan(graph.describe(), {
      package: packageIdentity,
      admission: {
        package: packageIdentity,
        permissions: [{ name: 'workspace.write', scope: { paths: ['packages/runtime'] } }],
      },
      executionLanes: [],
    }),
    resolvedInputs: {},
    workspaceBinding: null,
    hostBinding: null,
  });
  return { runId, storage };
}

const hash = (digit: string): Sha256Digest => `sha256:${digit.repeat(64)}` as Sha256Digest;

const approvalSubject = (output = 'approved bytes'): ApprovalSubjectInput => ({
  workspaceAnchor: null,
  inputArtifactHashes: { source: hash('5') },
  proofScope: { kind: 'change', paths: ['packages/runtime'] },
  proofArtifact: {
    schemaVersion: 1,
    digest: hash('2'),
    byteLength: 128,
    mediaType: 'application/json',
    purpose: 'proof-packet',
  },
  proposedOutput: new TextEncoder().encode(output),
  effectivePermissions: [{
    name: 'workspace.write',
    scope: { paths: ['packages/runtime'] },
  }],
});

const gate = (revision: string) => createCallbackGate({
  gateId: 'release-approval',
  gateVersion: 1,
  decisionText: 'Approve this revision?',
  responseSchema: {
    type: 'object',
    properties: { approved: { type: 'boolean' } },
    required: ['approved'],
  },
  input: { revision },
});

const approvalGate = (revision: string, subject: ApprovalSubjectInput) => createApprovalCallbackGate({
  gateId: 'apply-change',
  gateVersion: 1,
  decisionText: 'Apply these exact bytes?',
  responseSchema: {
    type: 'object',
    properties: { kind: { type: 'string' } },
    required: ['kind'],
  },
  input: { revision },
}, subject);

async function runEvents(
  storage: RunStorageBinding,
  runId: string,
): Promise<readonly DomainEventEnvelope[]> {
  const events: DomainEventEnvelope[] = [];
  for await (const event of storage.eventStore.read({
    namespace: storage.record.namespace,
    streamId: runId,
  })) events.push(event);
  return events;
}

function observeBatches(
  storage: RunStorageBinding,
  batches: DomainEventBatch[],
): RunStorageBinding {
  const eventStore = storage.eventStore;
  return {
    ...storage,
    eventStore: {
      preflightAppend: eventStore.preflightAppend.bind(eventStore),
      read: eventStore.read.bind(eventStore),
      append: async (stream, expectedRevision, events) => {
        batches.push(events);
        return eventStore.append(stream, expectedRevision, events);
      },
    },
  };
}

function rejectApprovalBatches(storage: RunStorageBinding): RunStorageBinding {
  const eventStore = storage.eventStore;
  return {
    ...storage,
    eventStore: {
      preflightAppend: eventStore.preflightAppend.bind(eventStore),
      read: eventStore.read.bind(eventStore),
      append: async (stream, expectedRevision, events) => {
        if (events.some((event) => event.type === 'callback:approval-recorded')) {
          throw new StorageError('STORAGE_LIMIT_EXCEEDED', 'fixture approval batch failed');
        }
        return eventStore.append(stream, expectedRevision, events);
      },
    },
  };
}

describe('stored callback client', () => {
  it('uses the run stream revision so two stored claims have one winner', async () => {
    const { runId, storage } = await storedRun();
    const request = gate('abc123');
    const writer = await createStoredCallbackClient(storage, runId);
    await writer.post(request);
    const first = await createStoredCallbackClient(storage, runId);
    const second = await createStoredCallbackClient(storage, runId);

    const results = await Promise.all([
      first.claim(request.requestId, 'router-a'),
      second.claim(request.requestId, 'router-b'),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ kind: 'claimed' }),
    ]);
  });

  it('a callback without an approval subject is unchanged', async () => {
    const { runId, storage } = await storedRun();
    const request = gate('abc123');
    const first = await createStoredCallbackClient(storage, runId);
    await first.post(request);
    const claim = await first.claim(request.requestId, 'router-a');
    if (!claim.ok) throw new Error('fixture claim failed');
    expect(await first.submit(
      request.requestId,
      claim.claimToken,
      'router-a',
      request.digest,
      { approved: true },
    )).toMatchObject({ ok: true });

    const restarted = await createStoredCallbackClient(storage, runId);
    expect(await restarted.history(request.requestId)).toContainEqual(expect.objectContaining({
      kind: 'callback-submitted',
      response: { approved: true },
    }));
    expect(await restarted.claim(request.requestId, 'router-b'))
      .toMatchObject({ ok: false, kind: 'answered' });

    const changed = gate('def456');
    await restarted.post(changed);
    expect((await restarted.listPending()).map((pending) => pending.requestId))
      .toEqual([changed.requestId]);
    expect((await restarted.history(changed.requestId)).some((event) => (
      event.kind === 'callback-submitted'
    ))).toBe(false);

    const events = await runEvents(storage, runId);
    const requested = events.find((event) => (
      event.type === 'callback:history-recorded'
      && (event.payload as { event?: { kind?: string } }).event?.kind === 'callback-requested'
    ));
    expect(Object.keys(requested?.payload ?? {})).toEqual(['event']);
    expect(events.some((event) => event.type === 'callback:approval-recorded')).toBe(false);
  });

  it.each([
    {
      defect: 'omitted requestDigest',
      corrupt: ({ requestDigest: _digest, ...event }: JsonObject) => event,
      message: 'a stored callback submission has an invalid requestDigest',
    },
    {
      defect: 'malformed requestDigest',
      corrupt: (event: JsonObject) => ({ ...event, requestDigest: 'not-a-digest' }),
      message: 'a stored callback submission has an invalid requestDigest',
    },
    {
      defect: 'an extra field',
      corrupt: (event: JsonObject) => ({ ...event, unexpected: true }),
      message: 'a stored callback event has missing or unknown fields',
    },
  ])('refuses stored replay with $defect', async ({ corrupt, message }) => {
    const { runId, storage } = await storedRun();
    const request = gate('abc123');
    const client = await createStoredCallbackClient(storage, runId);
    await client.post(request);
    const claim = await client.claim(request.requestId, 'router-a');
    if (!claim.ok) throw new Error('fixture claim failed');
    const submission: JsonObject = {
      kind: 'callback-submitted',
      requestId: request.requestId,
      requestDigest: request.digest,
      routerId: 'router-a',
      response: { approved: true },
    };
    const before = await runEvents(storage, runId);
    await storage.eventStore.append({
      namespace: storage.record.namespace,
      streamId: runId,
    }, before.at(-1)?.revision ?? 0, [{
      eventId: randomUUID(),
      type: 'callback:history-recorded',
      version: 1,
      timestamp: new Date().toISOString(),
      correlationId: runId,
      causationId: null,
      payload: { event: corrupt(submission) },
    }]);

    const restarted = await createStoredCallbackClient(storage, runId);
    await expect(restarted.history(request.requestId)).rejects.toMatchObject({
      name: 'TypeError',
      message,
    });
  });

  it('submits a subject-backed callback and approval in one batch, then resolves only matching bytes after reopen', async () => {
    const { runId, storage } = await storedRun();
    const subject = approvalSubject();
    const request = approvalGate('abc123', subject);
    const batches: DomainEventBatch[] = [];
    const observed = observeBatches(storage, batches);
    const writer = await createStoredCallbackClient(observed, runId);

    await writer.post(request, subject);
    const restarted = await createStoredCallbackClient(observed, runId);
    const claim = await restarted.claim(request.requestId, 'router-a');
    if (!claim.ok) throw new Error('fixture claim failed');
    await expect(restarted.submit(
      request.requestId,
      claim.claimToken,
      'router-a',
      request.digest,
      { kind: 'allow' },
      { id: 'owner', kind: 'human' },
    )).resolves.toMatchObject({ ok: true });

    const approvalBatch = batches.find((batch) => (
      batch.some((event) => event.type === 'callback:approval-recorded')
    ));
    expect(approvalBatch?.map((event) => event.type)).toEqual([
      'callback:history-recorded',
      'callback:approval-recorded',
    ]);
    expect((approvalBatch?.[0].payload as { event?: { kind?: string } }).event?.kind)
      .toBe('callback-submitted');

    await expect(resolveApproval(storage, runId, { request, ...subject }))
      .resolves.toEqual({ kind: 'allow' });
    await expect(resolveApproval(storage, runId, {
      request,
      ...subject,
      proposedOutput: new TextEncoder().encode('approved byteS'),
    })).resolves.toMatchObject({ kind: 'wait' });
  });

  it('refuses a repeated plain submission after an answer with not-claimed', async () => {
    const { runId, storage } = await storedRun();
    const request = gate('abc123');
    const client = await createStoredCallbackClient(storage, runId);
    await client.post(request);
    const claim = await client.claim(request.requestId, 'router-a');
    if (!claim.ok) throw new Error('fixture claim failed');
    await expect(client.submit(
      request.requestId,
      claim.claimToken,
      'router-a',
      request.digest,
      { approved: true },
    )).resolves.toEqual({ ok: true, response: { approved: true } });
    const before = await runEvents(storage, runId);

    const restarted = await createStoredCallbackClient(storage, runId);
    await expect(restarted.submit(
      request.requestId,
      claim.claimToken,
      'router-a',
      request.digest,
      { approved: true },
    )).resolves.toMatchObject({ ok: false, kind: 'not-claimed' });
    expect(await runEvents(storage, runId)).toEqual(before);
  });

  it('a repeated identical subject-backed submit is idempotent', async () => {
    const { runId, storage } = await storedRun();
    const subject = approvalSubject();
    const request = approvalGate('abc123', subject);
    const client = await createStoredCallbackClient(storage, runId);
    await client.post(request, subject);
    const claim = await client.claim(request.requestId, 'router-a');
    if (!claim.ok) throw new Error('fixture claim failed');
    const submit = () => client.submit(
      request.requestId,
      claim.claimToken,
      'router-a',
      request.digest,
      { kind: 'allow' },
      { id: 'owner', kind: 'human' },
    );

    await expect(submit()).resolves.toMatchObject({ ok: true });
    await expect(submit()).resolves.toMatchObject({ ok: true });

    const events = await runEvents(storage, runId);
    expect(events.filter((event) => (
      event.type === 'callback:approval-recorded'
    ))).toHaveLength(1);
    expect(events.filter((event) => (
      event.type === 'callback:history-recorded'
      && (event.payload as { event?: { kind?: string } }).event?.kind === 'callback-submitted'
    ))).toHaveLength(1);
  });

  it('two differing subject-backed submissions for one request: the second is refused', async () => {
    const { runId, storage } = await storedRun();
    const subject = approvalSubject();
    const request = approvalGate('abc123', subject);
    const writer = await createStoredCallbackClient(storage, runId);
    await writer.post(request, subject);
    const claim = await writer.claim(request.requestId, 'router-a');
    if (!claim.ok) throw new Error('fixture claim failed');
    const first = await createStoredCallbackClient(storage, runId);
    const second = await createStoredCallbackClient(storage, runId);

    const settled = await Promise.allSettled([
      first.submit(
        request.requestId,
        claim.claimToken,
        'router-a',
        request.digest,
        { kind: 'allow' },
        { id: 'owner', kind: 'human' },
      ),
      second.submit(
        request.requestId,
        claim.claimToken,
        'router-a',
        request.digest,
        { kind: 'deny', reason: 'not approved' },
        { id: 'owner', kind: 'human' },
      ),
    ]);

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'REVISION_CONFLICT' }) }),
    ]);
    const events = await runEvents(storage, runId);
    expect(events.filter((event) => event.type === 'callback:approval-recorded'))
      .toHaveLength(1);
  });

  it('does not answer a subject-backed callback when the approval batch fails', async () => {
    const { runId, storage } = await storedRun();
    const subject = approvalSubject();
    const request = approvalGate('abc123', subject);
    const writer = await createStoredCallbackClient(storage, runId);
    await writer.post(request, subject);
    const claim = await writer.claim(request.requestId, 'router-a');
    if (!claim.ok) throw new Error('fixture claim failed');
    const failing = await createStoredCallbackClient(rejectApprovalBatches(storage), runId);

    await expect(failing.submit(
      request.requestId,
      claim.claimToken,
      'router-a',
      request.digest,
      { kind: 'allow' },
      { id: 'owner', kind: 'human' },
    )).rejects.toMatchObject({ code: 'STORAGE_LIMIT_EXCEEDED' });

    const reopened = await createStoredCallbackClient(storage, runId);
    expect((await reopened.history(request.requestId)).some((event) => (
      event.kind === 'callback-submitted'
    ))).toBe(false);
    expect((await runEvents(storage, runId)).some((event) => (
      event.type === 'callback:approval-recorded'
    ))).toBe(false);
  });

  it('does not answer when an approval exists without its callback submission', async () => {
    const { runId, storage } = await storedRun();
    const subject = approvalSubject();
    const request = approvalGate('abc123', subject);
    const client = await createStoredCallbackClient(storage, runId);
    await client.post(request, subject);
    const claim = await client.claim(request.requestId, 'router-a');
    if (!claim.ok) throw new Error('fixture claim failed');
    const run = await loadRunDefinition(storage, runId);
    const prepared = prepareApprovalRecord(runId, {
      request,
      planDigest: run.resolvedPlan.digest,
      graph: {
        definitionDigest: run.resolvedPlan.plan.graph.definitionDigest,
        typeVersion: run.resolvedPlan.plan.graph.typeVersion,
      },
      subject: snapshotApprovalSubject(subject),
      actor: { id: 'owner', kind: 'human' },
      responsePath: 'router-a',
      submission: {
        kind: 'callback-submitted',
        requestId: request.requestId,
        requestDigest: request.digest,
        routerId: 'router-a',
        response: { kind: 'allow' },
      },
    });
    const before = await runEvents(storage, runId);
    await storage.eventStore.append({
      namespace: storage.record.namespace,
      streamId: runId,
    }, before.at(-1)?.revision ?? 0, [prepared.event]);

    await expect(client.submit(
      request.requestId,
      claim.claimToken,
      'router-a',
      request.digest,
      { kind: 'allow' },
      { id: 'owner', kind: 'human' },
    )).rejects.toMatchObject({ code: 'INVALID_STORED_VALUE' });
    const after = await runEvents(storage, runId);
    expect(after.filter((event) => event.type === 'callback:approval-recorded'))
      .toHaveLength(1);
    expect(after.some((event) => (
      event.type === 'callback:history-recorded'
      && (event.payload as { event?: { kind?: string } }).event?.kind === 'callback-submitted'
    ))).toBe(false);
  });

  it('a schema-valid response that is not a decision cannot become approval', async () => {
    const { runId, storage } = await storedRun();
    const subject = approvalSubject();
    const request = approvalGate('abc123', subject);
    const client = await createStoredCallbackClient(storage, runId);
    await client.post(request, subject);
    const claim = await client.claim(request.requestId, 'router-a');
    if (!claim.ok) throw new Error('fixture claim failed');

    await expect(client.submit(
      request.requestId,
      claim.claimToken,
      'router-a',
      request.digest,
      { kind: 'bogus' },
      { id: 'owner', kind: 'human' },
    )).resolves.toMatchObject({ ok: false, kind: 'invalid' });
    expect((await client.history(request.requestId)).some((event) => (
      event.kind === 'callback-submitted'
    ))).toBe(false);
    expect((await runEvents(storage, runId)).some((event) => (
      event.type === 'callback:approval-recorded'
    ))).toBe(false);
  });

  it('a corrupt stored approval returns only its gate to wait', async () => {
    const { runId, storage } = await storedRun();
    const firstSubject = approvalSubject('first bytes');
    const firstRequest = approvalGate('abc123', firstSubject);
    const run = await loadRunDefinition(storage, runId);
    const prepared = prepareApprovalRecord(runId, {
      request: firstRequest,
      planDigest: run.resolvedPlan.digest,
      graph: {
        definitionDigest: run.resolvedPlan.plan.graph.definitionDigest,
        typeVersion: run.resolvedPlan.plan.graph.typeVersion,
      },
      subject: snapshotApprovalSubject(firstSubject),
      actor: { id: 'owner', kind: 'human' },
      responsePath: 'router-a',
      submission: {
        kind: 'callback-submitted',
        requestId: firstRequest.requestId,
        requestDigest: firstRequest.digest,
        routerId: 'router-a',
        response: { kind: 'allow' },
      },
    });
    const beforeCorruption = await runEvents(storage, runId);
    await storage.eventStore.append({
      namespace: storage.record.namespace,
      streamId: runId,
    }, beforeCorruption.at(-1)?.revision ?? 0, [{
      ...prepared.event,
      payload: {
        ...prepared.event.payload,
        record: { ...prepared.record, bindingDigest: hash('9') },
      },
    }]);

    const secondSubject = approvalSubject('second bytes');
    const secondRequest = approvalGate('def456', secondSubject);
    const second = await createStoredCallbackClient(storage, runId);
    await second.post(secondRequest, secondSubject);
    expect((await second.listPending()).map((pending) => pending.requestId))
      .toEqual([secondRequest.requestId]);
    const secondClaim = await second.claim(secondRequest.requestId, 'router-b');
    if (!secondClaim.ok) throw new Error('fixture claim failed');
    await second.submit(
      secondRequest.requestId,
      secondClaim.claimToken,
      'router-b',
      secondRequest.digest,
      { kind: 'allow' },
      { id: 'other-owner', kind: 'human' },
    );

    await expect(resolveApproval(storage, runId, {
      request: firstRequest,
      ...firstSubject,
    })).resolves.toMatchObject({ kind: 'wait' });
    await expect(resolveApproval(storage, runId, {
      request: secondRequest,
      ...secondSubject,
    })).resolves.toEqual({ kind: 'allow' });
  });

  it('approve, change the subject bytes, and the run asks again', async () => {
    const { runId, storage } = await storedRun();
    const firstSubject = approvalSubject('first bytes');
    const firstRequest = approvalGate('abc123', firstSubject);
    const client = await createStoredCallbackClient(storage, runId);
    await client.post(firstRequest, firstSubject);
    const firstClaim = await client.claim(firstRequest.requestId, 'router-a');
    if (!firstClaim.ok) throw new Error('fixture claim failed');
    await client.submit(
      firstRequest.requestId,
      firstClaim.claimToken,
      'router-a',
      firstRequest.digest,
      { kind: 'allow' },
      { id: 'owner', kind: 'human' },
    );

    const changedSubject = approvalSubject('changed bytes');
    const changedRequest = approvalGate('abc123', changedSubject);
    expect(changedRequest.requestId).not.toBe(firstRequest.requestId);
    await expect(resolveApproval(storage, runId, {
      request: changedRequest,
      ...changedSubject,
    })).resolves.toMatchObject({ kind: 'wait' });

    await client.post(changedRequest, changedSubject);
    expect((await client.listPending()).map((pending) => pending.requestId))
      .toEqual([changedRequest.requestId]);
    const changedClaim = await client.claim(changedRequest.requestId, 'router-a');
    expect(changedClaim.ok).toBe(true);
  });

  it('a subject that does not match the digest in the input is refused typed', async () => {
    const { runId, storage } = await storedRun();
    const namedSubject = approvalSubject('named bytes');
    const differentSubject = approvalSubject('different bytes');
    const request = approvalGate('abc123', namedSubject);
    const client = await createStoredCallbackClient(storage, runId);

    await expect(client.post(request, differentSubject)).rejects.toMatchObject({
      code: 'SUBJECT_MISMATCH',
    });
    expect(await client.history()).toEqual([]);
  });

  it('an approval request without its subject is refused typed', async () => {
    const { runId, storage } = await storedRun();
    const subject = approvalSubject();
    const request = approvalGate('abc123', subject);
    const client = await createStoredCallbackClient(storage, runId);

    await expect(client.post(request)).rejects.toMatchObject({
      code: 'SUBJECT_MISMATCH',
    });
    expect(await client.history()).toEqual([]);
  });
});
