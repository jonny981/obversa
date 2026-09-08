import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createApprovalCallbackGate,
  prepareApprovalRecord,
  resolveApproval,
  snapshotApprovalSubject,
  validateApprovalRecord,
  type ApprovalRecord,
  type ApprovalSubjectInput,
} from '../src/callback/approval.js';
import { createStoredCallbackClient } from '../src/callback/stored-client.js';
import type { CallbackGateDefinition, CallbackRequest } from '../src/callback/gate.js';
import type { DomainEventEnvelope } from '../src/events/envelope.js';
import { digestJson, type JsonObject, type Sha256Digest } from '../src/graph/value.js';
import type { WorkspaceAnchor } from '../src/workspace/provider.js';
import { loadRunDefinition } from '../src/runtime/run-definition.js';
import { appendRunEvent } from '../src/runtime/run-event.js';
import {
  createStoredRunFixture,
  type StoredRunFixture,
} from './stored-run-fixture.js';

// Real work: these tests write files to temporary directories on disk, so
// this file declares its own time limit; the suite default is a hang guard,
// not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const hash = (digit: string): Sha256Digest => `sha256:${digit.repeat(64)}` as Sha256Digest;

const workspaceAnchor: WorkspaceAnchor = {
  schemaVersion: 1,
  root: '/repo',
  repositoryId: '/repo/.git',
  head: 'a'.repeat(40),
  fingerprint: 'b'.repeat(64),
  scope: null,
  files: [],
};

const proofArtifact = {
  schemaVersion: 1,
  digest: hash('2'),
  byteLength: 128,
  mediaType: 'application/json',
  purpose: 'proof-packet',
} as const;

const definition: CallbackGateDefinition = {
  gateId: 'apply-change',
  gateVersion: 1,
  decisionText: 'Apply the proposed bytes?',
  responseSchema: {
    type: 'object',
    properties: { kind: { type: 'string' } },
    required: ['kind'],
  },
  input: { proofArtifactDigest: hash('2'), proposedOutputDigest: hash('3') },
};

function approvalSubject(
  change: Partial<ApprovalSubjectInput> = {},
): ApprovalSubjectInput {
  return {
    workspaceAnchor,
    inputArtifactHashes: { source: hash('5') },
    proofScope: { kind: 'change', paths: ['packages/runtime'] },
    proofArtifact,
    proposedOutput: new TextEncoder().encode('approved bytes'),
    effectivePermissions: [{
      name: 'workspace.write',
      scope: { paths: ['packages/runtime'] },
    }],
    ...change,
  };
}

function approvalRequest(
  subject: ApprovalSubjectInput,
  change: Partial<CallbackGateDefinition> = {},
): CallbackRequest {
  return createApprovalCallbackGate({ ...definition, ...change }, subject);
}

let run: StoredRunFixture;

beforeEach(async () => {
  run = await createStoredRunFixture('approval', [
    { name: 'workspace.write', scope: { paths: ['packages/runtime'] } },
    { name: 'workspace.read', scope: { paths: ['packages/runtime'], recursive: true } },
  ]);
});

afterEach(async () => {
  await run.close();
});

async function submitApproval(
  subject: ApprovalSubjectInput,
  request = approvalRequest(subject),
  response: JsonObject = { kind: 'allow' },
) {
  const client = await createStoredCallbackClient(run.storage, run.runId);
  await client.post(request, subject);
  const claim = await client.claim(request.requestId, 'router-a');
  if (!claim.ok) throw new Error('fixture claim failed');
  const submitted = await client.submit(
    request.requestId,
    claim.claimToken,
    'router-a',
    request.digest,
    response,
    { id: 'owner', kind: 'human' },
  );
  return { client, request, submitted };
}

async function approvalEvents(): Promise<readonly DomainEventEnvelope[]> {
  const events: DomainEventEnvelope[] = [];
  for await (const event of run.storage.eventStore.read({
    namespace: run.storage.record.namespace,
    streamId: run.runId,
  })) {
    if (event.type === 'callback:approval-recorded') events.push(event);
  }
  return events;
}

async function storeApprovalRequest(subject: ApprovalSubjectInput) {
  const request = approvalRequest(subject);
  // Replay a request written before permission checks were enforced.
  await appendRunEvent(run.storage, run.runId, {
    eventId: randomUUID(),
    type: 'callback:history-recorded',
    version: 1,
    timestamp: new Date().toISOString(),
    correlationId: run.runId,
    causationId: null,
    payload: {
      event: { kind: 'callback-requested', request },
      approvalSubject: snapshotApprovalSubject(subject),
    },
  });
  return request;
}

describe('callback approval', () => {
  it.each([
    { name: 'network.connect', scope: { paths: ['packages/runtime'] } },
    { name: 'workspace.write', scope: { paths: ['packages'] } },
    { name: 'workspace.write', scope: { paths: ['packages/runtime/src'] } },
  ])('rejects posting a permission outside the admitted grants: %j', async (permission) => {
    const subject = approvalSubject({ effectivePermissions: [permission] });
    const client = await createStoredCallbackClient(run.storage, run.runId);

    await expect(client.post(approvalRequest(subject), subject))
      .rejects.toMatchObject({ code: 'SUBJECT_MISMATCH' });
    expect(await client.history()).toEqual([]);
    expect(await approvalEvents()).toEqual([]);
  });

  it('cannot approve a write when the stored plan admits no permissions', async () => {
    await run.close();
    run = await createStoredRunFixture('approval-no-permissions');
    const subject = approvalSubject();
    const request = await storeApprovalRequest(subject);
    const client = await createStoredCallbackClient(run.reopen(), run.runId);
    const claim = await client.claim(request.requestId, 'router-a');
    if (!claim.ok) throw new Error('fixture claim failed');

    await expect(client.submit(
      request.requestId,
      claim.claimToken,
      'router-a',
      request.digest,
      { kind: 'allow' },
      { id: 'owner', kind: 'human' },
    )).resolves.toMatchObject({ ok: false, kind: 'invalid' });
    expect((await client.history()).some((event) => (
      event.kind === 'callback-submitted'
    ))).toBe(false);
    expect(await approvalEvents()).toEqual([]);
  });

  it('a stored allow outside admission resolves to wait', async () => {
    const subject = approvalSubject({
      effectivePermissions: [{ name: 'workspace.write', scope: { paths: ['packages'] } }],
    });
    const request = await storeApprovalRequest(subject);
    const stored = await loadRunDefinition(run.storage, run.runId);
    const prepared = prepareApprovalRecord(run.runId, {
      request,
      planDigest: stored.resolvedPlan.digest,
      graph: {
        definitionDigest: stored.resolvedPlan.plan.graph.definitionDigest,
        typeVersion: stored.resolvedPlan.plan.graph.typeVersion,
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
    await appendRunEvent(run.storage, run.runId, prepared.event);

    await expect(resolveApproval(run.reopen(), run.runId, { request, ...subject }))
      .resolves.toMatchObject({ kind: 'wait' });
  });

  it.each([
    { permissions: [] },
    { permissions: [{ name: 'workspace.read', scope: { recursive: true, paths: ['packages/runtime'] } }] },
  ])('allows a subset of admitted grants with reordered JSON keys: %j', async ({ permissions }) => {
    const subject = approvalSubject({ effectivePermissions: permissions });
    const { request, submitted } = await submitApproval(subject);

    expect(submitted).toMatchObject({ ok: true });
    await expect(resolveApproval(run.reopen(), run.runId, { request, ...subject }))
      .resolves.toEqual({ kind: 'allow' });
  });

  it('changing one approved byte invalidates approval', async () => {
    const subject = approvalSubject();
    const request = approvalRequest(subject);
    await submitApproval(subject, request);

    await expect(resolveApproval(run.reopen(), run.runId, { request, ...subject }))
      .resolves.toEqual({ kind: 'allow' });
    await expect(resolveApproval(run.reopen(), run.runId, {
      request,
      ...subject,
      proposedOutput: new TextEncoder().encode('approved byteS'),
    })).resolves.toMatchObject({ kind: 'wait' });
  });

  it('changing the callback gate definition invalidates approval', async () => {
    const subject = approvalSubject();
    const request = approvalRequest(subject);
    await submitApproval(subject, request);
    const changes: Partial<CallbackGateDefinition>[] = [
      { gateVersion: 2 },
      { decisionText: 'Apply different bytes?' },
      {
        responseSchema: {
          ...definition.responseSchema,
          required: ['kind', 'reason'],
        },
      },
      { input: { proofArtifactDigest: hash('2'), proposedOutputDigest: hash('6') } },
    ];

    for (const change of changes) {
      const changed = approvalRequest(subject, change);
      await expect(resolveApproval(run.reopen(), run.runId, {
        request: changed,
        ...subject,
      })).resolves.toMatchObject({ kind: 'wait' });
    }
  });

  it('an invalid structured response cannot become approval', async () => {
    const subject = approvalSubject();
    const request = approvalRequest(subject);
    const { client, submitted } = await submitApproval(subject, request, { kind: 1 });

    expect(submitted).toMatchObject({ ok: false, kind: 'invalid' });
    expect((await client.history(request.requestId)).some((event) => (
      event.kind === 'callback-submitted'
    ))).toBe(false);
    expect(await approvalEvents()).toEqual([]);
  });

  it('a changed proof byte returns the matching gate to wait', async () => {
    const subject = approvalSubject();
    const request = approvalRequest(subject);
    await submitApproval(subject, request);

    await expect(resolveApproval(run.reopen(), run.runId, {
      request,
      ...subject,
      proofArtifact: { ...proofArtifact, digest: hash('6') },
    })).resolves.toMatchObject({ kind: 'wait' });
  });

  it('a valid stored response survives a restart; a changed request does not', async () => {
    const subject = approvalSubject();
    const request = approvalRequest(subject);
    await submitApproval(subject, request);

    const restarted = await createStoredCallbackClient(run.reopen(), run.runId);
    expect(await restarted.history(request.requestId)).toContainEqual(expect.objectContaining({
      kind: 'callback-submitted',
      response: { kind: 'allow' },
    }));
    await expect(resolveApproval(run.reopen(), run.runId, { request, ...subject }))
      .resolves.toEqual({ kind: 'allow' });

    const changedSubject = approvalSubject({
      proposedOutput: new TextEncoder().encode('changed bytes'),
    });
    const changedRequest = approvalRequest(changedSubject);
    await expect(resolveApproval(run.reopen(), run.runId, {
      request: changedRequest,
      ...changedSubject,
    })).resolves.toMatchObject({ kind: 'wait' });
    await restarted.post(changedRequest, changedSubject);
    expect((await restarted.listPending()).map((pending) => pending.requestId))
      .toEqual([changedRequest.requestId]);
  });

  it('stores a valid record when no workspace is bound', async () => {
    const subject = approvalSubject({ workspaceAnchor: null });
    const request = approvalRequest(subject);
    await submitApproval(subject, request);

    const [event] = await approvalEvents();
    const payload = event?.payload as { record?: unknown } | undefined;
    expect(validateApprovalRecord(payload?.record)).toMatchObject({
      binding: { workspaceAnchor: null },
    });
    await expect(resolveApproval(run.reopen(), run.runId, { request, ...subject }))
      .resolves.toEqual({ kind: 'allow' });
  });

  it('rejects a configured secret in actor identity without storing the answer or approval', async () => {
    await run.close();
    run = await createStoredRunFixture('approval', [], ['fixture-credential']);
    const subject = approvalSubject({ workspaceAnchor: null, effectivePermissions: [] });
    const request = approvalRequest(subject);
    const client = await createStoredCallbackClient(run.storage, run.runId);
    await client.post(request, subject);
    const claim = await client.claim(request.requestId, 'router-a');
    if (!claim.ok) throw new Error('fixture claim failed');
    await expect(client.submit(
      request.requestId, claim.claimToken, 'router-a', request.digest,
      { kind: 'allow' }, { id: 'owner', context: { value: 'fixture-credential' } },
    )).rejects.toMatchObject({ code: 'KNOWN_SECRET' });
    const restarted = await createStoredCallbackClient(run.reopen(), run.runId);
    expect((await restarted.history(request.requestId)).some((event) => event.kind === 'callback-submitted'))
      .toBe(false);
    expect(await approvalEvents()).toEqual([]);
    await expect(resolveApproval(run.reopen(), run.runId, { request, ...subject }))
      .resolves.toMatchObject({ kind: 'wait' });
  });

  it('a second valid approval event cannot replace the first', async () => {
    const subject = approvalSubject();
    const request = approvalRequest(subject);
    await submitApproval(subject, request);
    const [first] = await approvalEvents();
    if (first === undefined) throw new Error('fixture approval missing');
    const payload = first.payload as { requestId: string; record: ApprovalRecord };
    const binding = {
      ...payload.record.binding,
      actor: { id: 'other-owner', kind: 'human' },
      decision: { kind: 'deny', reason: 'replacement' },
    } as const;
    const replacement = validateApprovalRecord({
      ...payload.record,
      binding,
      bindingDigest: digestJson(binding),
    });
    await run.storage.eventStore.append({
      namespace: run.storage.record.namespace,
      streamId: run.runId,
    }, first.revision, [{
      eventId: randomUUID(),
      type: 'callback:approval-recorded',
      version: 1,
      timestamp: new Date().toISOString(),
      correlationId: run.runId,
      causationId: null,
      payload: { requestId: request.requestId, record: replacement },
    }]);

    await expect(resolveApproval(run.reopen(), run.runId, { request, ...subject }))
      .resolves.toMatchObject({ kind: 'wait' });
  });
});
