import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createApprovalCallbackGate,
  resolveApproval,
  validateApprovalRecord,
  type ApprovalRecord,
  type ApprovalSubjectInput,
} from '../src/callback/approval.js';
import { createStoredCallbackClient } from '../src/callback/stored-client.js';
import type { CallbackGateDefinition, CallbackRequest } from '../src/callback/gate.js';
import type { DomainEventEnvelope } from '../src/events/envelope.js';
import { digestJson, type JsonObject, type Sha256Digest } from '../src/graph/value.js';
import type { WorkspaceAnchor } from '../src/workspace/provider.js';
import {
  createStoredRunFixture,
  type StoredRunFixture,
} from './stored-run-fixture.js';

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
  run = await createStoredRunFixture('approval');
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

describe('callback approval', () => {
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
