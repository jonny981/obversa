import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createAcceptedResultRecord,
  resolveAcceptedResult,
  validateAcceptedResultRecord,
  type AcceptedResultBindingInput,
  type AcceptedResultRecord,
} from '../src/proof/acceptance.js';
import {
  digestJson,
  type JsonValue,
  type Sha256Digest,
} from '../src/graph/value.js';
import {
  loadRunDefinition,
  type RunStorageBinding,
} from '../src/runtime/run-definition.js';
import { StorageError } from '../src/storage/error.js';
import type { WorkspaceAnchor } from '../src/workspace/provider.js';
import {
  createStoredRunFixture,
  raceFirstTwoEventAppends,
  recordFixtureDispatches,
  recordFixtureCompletions,
  rejectEventAppends,
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

let run: StoredRunFixture;
let binding: AcceptedResultBindingInput;

beforeEach(async () => {
  run = await createStoredRunFixture('acceptance');
  const stored = await loadRunDefinition(run.storage, run.runId);
  binding = {
    inputHashes: { draft: hash('1') },
    proofScope: { kind: 'review', paths: ['packages/runtime'] },
    proofArtifact,
    graph: {
      definitionDigest: stored.resolvedPlan.plan.graph.definitionDigest,
      typeVersion: stored.resolvedPlan.plan.graph.typeVersion,
    },
    workspaceAnchor,
    reviewerIdentity: {
      promptDigest: hash('4'),
      adapter: 'mock',
      provider: 'test',
      modelFamily: 'fixture',
      model: 'fixture-1',
      skills: [],
      tools: [],
      settings: {},
    },
  };
});

afterEach(async () => {
  await run.close();
});

function acceptedRecordFor(
  current: AcceptedResultBindingInput,
  result: JsonValue,
): AcceptedResultRecord {
  const storedBinding = {
    ...current,
    reviewerFingerprint: digestJson(current.reviewerIdentity),
  };
  return validateAcceptedResultRecord({
    schemaVersion: 1,
    result,
    resultDigest: digestJson(result),
    binding: storedBinding,
    bindingDigest: digestJson(storedBinding),
  });
}

async function appendAcceptedRecord(
  position: string,
  record: AcceptedResultRecord,
): Promise<void> {
  let revision = 0;
  for await (const event of run.storage.eventStore.read({
    namespace: run.storage.record.namespace,
    streamId: run.runId,
  })) revision = event.revision;
  await run.storage.eventStore.append({
    namespace: run.storage.record.namespace,
    streamId: run.runId,
  }, revision, [{
    eventId: randomUUID(),
    type: 'proof:result-accepted',
    version: 1,
    timestamp: new Date().toISOString(),
    correlationId: run.runId,
    causationId: null,
    payload: { position, record },
  }]);
}

async function recordCompletedReviews(
  reviewA: JsonValue = { verdict: 'pass' },
  reviewB: JsonValue = { verdict: 'pass' },
) {
  const positions = await recordFixtureDispatches(run);
  await recordFixtureCompletions(run, { reviewA, reviewB });
  return positions;
}

async function appendNodeEvent(
  type: string,
  payload: Record<string, JsonValue>,
  version = 1,
): Promise<void> {
  let revision = 0;
  const stream = { namespace: run.storage.record.namespace, streamId: run.runId };
  for await (const event of run.storage.eventStore.read(stream)) revision = event.revision;
  await run.storage.eventStore.append(stream, revision, [{
    eventId: randomUUID(), type, version,
    timestamp: new Date().toISOString(), correlationId: run.runId, causationId: null,
    payload,
  }]);
}

describe('accepted result', () => {
  it('refuses a null workspace anchor even when the run has no workspace', async () => {
    const { reviewA: position } = await recordCompletedReviews();
    const stored = await loadRunDefinition(run.storage, run.runId);
    expect(stored.record.payload.definition.workspaceBinding).toBeNull();
    await expect(createAcceptedResultRecord(run.storage, run.runId, position, {
      result: { verdict: 'pass' },
      ...binding,
      workspaceAnchor: null as unknown as WorkspaceAnchor,
    })).rejects.toThrow('invalid accepted-result binding');
  });

  it('rejects a configured secret in reviewer identity before storing acceptance', async () => {
    await run.close();
    run = await createStoredRunFixture('acceptance', [], ['fixture-credential']);
    const { reviewA: position } = await recordCompletedReviews();
    await expect(createAcceptedResultRecord(run.storage, run.runId, position, {
      result: { verdict: 'pass' },
      ...binding,
      reviewerIdentity: { id: 'reviewer', settings: { value: 'fixture-credential' } },
    })).rejects.toMatchObject({ code: 'KNOWN_SECRET' });
    const events = [];
    for await (const event of run.reopen().eventStore.read({
      namespace: run.storage.record.namespace, streamId: run.runId,
    })) events.push(event);
    expect(events.some((event) => event.type === 'proof:result-accepted')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('fixture-credential');
  });

  it.each(
    ['in-flight', 'failed', 'wrong-result', 'wrong-node', 'wrong-version', 'extra-field', 'duplicate', 'before-dispatch']
      .flatMap((state) => ['create', 'resolve'].map((operation) => [state, operation])),
  )(
    'a %s completion cannot %s an accepted result',
    async (state, operation) => {
      const position = 'dag/review-a/1';
      const completed = { nodeId: 'review-a', position, result: { verdict: 'pass' } };
      if (state === 'before-dispatch') await appendNodeEvent('graph:node-completed', completed);
      await recordFixtureDispatches(run);
      if (state === 'failed') {
        await appendNodeEvent('graph:node-failed', { nodeId: 'review-a', position, code: 'DENIED' });
      } else if (state !== 'in-flight' && state !== 'before-dispatch') {
        await appendNodeEvent('graph:node-completed', {
          ...completed,
          ...(state === 'wrong-result' ? { result: { verdict: 'deny' } } : {}),
          ...(state === 'wrong-node' ? { nodeId: 'review-b' } : {}),
          ...(state === 'extra-field' ? { extra: true } : {}),
        }, state === 'wrong-version' ? 2 : 1);
        if (state === 'duplicate') await appendNodeEvent('graph:node-completed', completed);
      }
      if (operation === 'create') {
        await expect(createAcceptedResultRecord(run.storage, run.runId, position, {
          result: { verdict: 'pass' }, ...binding,
        })).rejects.toMatchObject({ code: 'INVALID_STORED_VALUE' });
      } else {
        await appendAcceptedRecord(position, acceptedRecordFor(binding, { verdict: 'pass' }));
        await expect(resolveAcceptedResult(run.reopen(), run.runId, position, binding))
          .resolves.toMatchObject({ kind: 'wait' });
      }
    },
  );

  it.each(['reviewer', 'inputs'])(
    'a changed %s invalidates an otherwise matching completed result',
    async (changed) => {
      const { reviewA: position } = await recordCompletedReviews();
      await createAcceptedResultRecord(run.storage, run.runId, position, {
        result: { verdict: 'pass' }, ...binding,
      });
      await expect(resolveAcceptedResult(run.reopen(), run.runId, position, binding))
        .resolves.toMatchObject({ kind: 'accepted' });
      const current = changed === 'reviewer'
        ? { ...binding, reviewerIdentity: { ...binding.reviewerIdentity, model: 'fixture-2' } }
        : { ...binding, inputHashes: { draft: hash('8') } };
      await expect(resolveAcceptedResult(run.reopen(), run.runId, position, current))
        .resolves.toMatchObject({ kind: 'wait' });
    },
  );

  it('an accepted result at a position this run never dispatched is refused', async () => {
    const { reviewA: sourcePosition } = await recordCompletedReviews();
    const missingPosition = 'dag/missing/1';
    const record = await createAcceptedResultRecord(
      run.storage,
      run.runId,
      sourcePosition,
      { result: { verdict: 'pass' }, ...binding },
    );

    await expect(createAcceptedResultRecord(
      run.storage,
      run.runId,
      missingPosition,
      { result: { verdict: 'pass' }, ...binding },
    )).rejects.toMatchObject({ code: 'INVALID_STORED_VALUE' });
    let revision = 0;
    for await (const event of run.storage.eventStore.read({
      namespace: run.storage.record.namespace,
      streamId: run.runId,
    })) revision = event.revision;
    await run.storage.eventStore.append({
      namespace: run.storage.record.namespace,
      streamId: run.runId,
    }, revision, [{
      eventId: randomUUID(),
      type: 'proof:result-accepted',
      version: 1,
      timestamp: new Date().toISOString(),
      correlationId: run.runId,
      causationId: null,
      payload: { position: missingPosition, record },
    }]);
    await expect(resolveAcceptedResult(
      run.reopen(),
      run.runId,
      missingPosition,
      binding,
    )).resolves.toMatchObject({ kind: 'wait' });
  });

  it('an accepted result whose graph digest differs from the stored plan is refused', async () => {
    const { reviewA: position } = await recordCompletedReviews();
    const wrong = {
      ...binding,
      graph: { ...binding.graph, definitionDigest: hash('9') },
    };

    await expect(createAcceptedResultRecord(
      run.storage,
      run.runId,
      position,
      {
        result: { verdict: 'pass' },
        ...wrong,
      },
    )).rejects.toMatchObject({ code: 'INVALID_STORED_VALUE' });

    await appendAcceptedRecord(position, acceptedRecordFor(wrong, { verdict: 'pass' }));
    await expect(resolveAcceptedResult(
      run.reopen(),
      run.runId,
      position,
      wrong,
    )).resolves.toMatchObject({ kind: 'wait' });
  });

  it('an accepted result whose graph type version differs from the stored plan is refused', async () => {
    const { reviewA: position } = await recordCompletedReviews();
    const wrong = {
      ...binding,
      graph: { ...binding.graph, typeVersion: binding.graph.typeVersion + 1 },
    };

    await expect(createAcceptedResultRecord(
      run.storage,
      run.runId,
      position,
      { result: { verdict: 'pass' }, ...wrong },
    )).rejects.toMatchObject({ code: 'INVALID_STORED_VALUE' });

    await appendAcceptedRecord(position, acceptedRecordFor(wrong, { verdict: 'pass' }));
    await expect(resolveAcceptedResult(
      run.reopen(),
      run.runId,
      position,
      wrong,
    )).resolves.toMatchObject({ kind: 'wait' });
  });

  it('a position dispatched twice cannot accept or resolve a result', async () => {
    const {
      reviewA: position,
      reviewB: sourcePosition,
    } = await recordCompletedReviews();
    let revision = 0;
    for await (const event of run.storage.eventStore.read({
      namespace: run.storage.record.namespace,
      streamId: run.runId,
    })) revision = event.revision;
    await run.storage.eventStore.append({
      namespace: run.storage.record.namespace,
      streamId: run.runId,
    }, revision, [{
      eventId: randomUUID(),
      type: 'graph:node-dispatched',
      version: 1,
      timestamp: new Date().toISOString(),
      correlationId: run.runId,
      causationId: null,
      payload: { nodeId: 'review-a', position },
    }]);

    await expect(createAcceptedResultRecord(
      run.storage,
      run.runId,
      position,
      { result: { verdict: 'pass' }, ...binding },
    )).rejects.toMatchObject({ code: 'INVALID_STORED_VALUE' });

    const record = await createAcceptedResultRecord(
      run.storage,
      run.runId,
      sourcePosition,
      { result: { verdict: 'pass' }, ...binding },
    );
    revision = 0;
    for await (const event of run.storage.eventStore.read({
      namespace: run.storage.record.namespace,
      streamId: run.runId,
    })) revision = event.revision;
    await run.storage.eventStore.append({
      namespace: run.storage.record.namespace,
      streamId: run.runId,
    }, revision, [{
      eventId: randomUUID(),
      type: 'proof:result-accepted',
      version: 1,
      timestamp: new Date().toISOString(),
      correlationId: run.runId,
      causationId: null,
      payload: { position, record },
    }]);

    await expect(resolveAcceptedResult(
      run.reopen(),
      run.runId,
      position,
      binding,
    )).resolves.toMatchObject({ kind: 'wait' });
  });

  it('refuses a graph position with control characters', async () => {
    await expect(createAcceptedResultRecord(
      run.storage,
      run.runId,
      'review/1/seat\x00a/1',
      { result: { verdict: 'pass' }, ...binding },
    )).rejects.toThrow('position');
  });

  it('two differently bound accepted records at one position: the second is refused', async () => {
    const { reviewA: position } = await recordCompletedReviews();
    const race = raceFirstTwoEventAppends(run.storage);
    const first = createAcceptedResultRecord(race.storage, run.runId, position, {
      result: { verdict: 'pass' },
      ...binding,
    });
    await race.firstAppendReached;
    const second = createAcceptedResultRecord(race.storage, run.runId, position, {
      result: { verdict: 'pass' },
      ...binding,
      reviewerIdentity: { ...binding.reviewerIdentity, model: 'fixture-2' },
    });

    await expect(first).resolves.toMatchObject({ result: { verdict: 'pass' } });
    await expect(second).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(resolveAcceptedResult(
      run.reopen(),
      run.runId,
      position,
      binding,
    )).resolves.toMatchObject({
      kind: 'accepted',
      record: { result: { verdict: 'pass' } },
    });
  });

  it('a repeated identical accepted result at one position is idempotent', async () => {
    const { reviewA: position } = await recordCompletedReviews();
    const race = raceFirstTwoEventAppends(run.storage);
    const first = createAcceptedResultRecord(race.storage, run.runId, position, {
      result: { verdict: 'pass' },
      ...binding,
    });
    await race.firstAppendReached;
    const second = createAcceptedResultRecord(race.storage, run.runId, position, {
      result: { verdict: 'pass' },
      ...binding,
    });

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    const events = [];
    for await (const event of run.reopen().eventStore.read({
      namespace: run.storage.record.namespace,
      streamId: run.runId,
    })) {
      if (event.type === 'proof:result-accepted') events.push(event);
    }
    expect(events).toHaveLength(1);
  });

  it('a second valid accepted result event cannot replace the first', async () => {
    const {
      reviewA: position,
      reviewB: replacementPosition,
    } = await recordCompletedReviews({ verdict: 'pass' }, { verdict: 'deny' });
    await createAcceptedResultRecord(run.storage, run.runId, position, {
      result: { verdict: 'pass' },
      ...binding,
    });
    const replacement = await createAcceptedResultRecord(
      run.storage,
      run.runId,
      replacementPosition,
      { result: { verdict: 'deny' }, ...binding },
    );
    let revision = 0;
    for await (const event of run.storage.eventStore.read({
      namespace: run.storage.record.namespace,
      streamId: run.runId,
    })) revision = event.revision;
    await run.storage.eventStore.append({
      namespace: run.storage.record.namespace,
      streamId: run.runId,
    }, revision, [{
      eventId: randomUUID(),
      type: 'proof:result-accepted',
      version: 1,
      timestamp: new Date().toISOString(),
      correlationId: run.runId,
      causationId: null,
      payload: { position, record: replacement },
    }]);

    await expect(resolveAcceptedResult(
      run.reopen(),
      run.runId,
      position,
      binding,
    )).resolves.toMatchObject({ kind: 'wait' });
  });

  it('the accepted-result record refuses reuse when the workspace anchor changed', async () => {
    const { reviewA: position } = await recordCompletedReviews({ verdict: 'pass', confidence: 0.9 });
    await createAcceptedResultRecord(run.storage, run.runId, position, {
      result: { verdict: 'pass', confidence: 0.9 },
      ...binding,
    });

    await expect(resolveAcceptedResult(
      run.reopen(),
      run.runId,
      position,
      binding,
    )).resolves.toMatchObject({ kind: 'accepted' });
    await expect(resolveAcceptedResult(run.reopen(), run.runId, position, {
      ...binding,
      workspaceAnchor: { ...workspaceAnchor, head: 'c'.repeat(40) },
    })).resolves.toMatchObject({ kind: 'wait' });
  });

  it('checks the accepted-result bytes captured before storage is read', async () => {
    const { reviewA: position } = await recordCompletedReviews();
    await createAcceptedResultRecord(run.storage, run.runId, position, {
      result: { verdict: 'pass' },
      ...binding,
    });
    const eventStore = run.storage.eventStore;
    let continueRead!: () => void;
    let markReadStarted!: () => void;
    const readMayContinue = new Promise<void>((resolve) => { continueRead = resolve; });
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    const delayedStorage: RunStorageBinding = {
      ...run.storage,
      eventStore: {
        preflightAppend: eventStore.preflightAppend.bind(eventStore),
        append: eventStore.append.bind(eventStore),
        read: async function* (stream, afterRevision) {
          markReadStarted();
          await readMayContinue;
          yield* eventStore.read(stream, afterRevision);
        },
      },
    };
    const mutableAnchor = { ...workspaceAnchor };
    const current = { ...binding, workspaceAnchor: mutableAnchor };

    const resolution = resolveAcceptedResult(delayedStorage, run.runId, position, current);
    await readStarted;
    mutableAnchor.head = 'c'.repeat(40);
    continueRead();

    await expect(resolution).resolves.toMatchObject({ kind: 'accepted' });
  });

  it('changing the accepted result bytes invalidates the record', async () => {
    const {
      reviewA: position,
      reviewB: otherPosition,
    } = await recordCompletedReviews({ verdict: 'pass' }, { verdict: 'pass', confidence: 0.9 });
    const record = await createAcceptedResultRecord(run.storage, run.runId, otherPosition, {
      result: { verdict: 'pass', confidence: 0.9 },
      ...binding,
    });
    let revision = 0;
    for await (const event of run.storage.eventStore.read({
      namespace: run.storage.record.namespace,
      streamId: run.runId,
    })) revision = event.revision;
    await run.storage.eventStore.append({
      namespace: run.storage.record.namespace,
      streamId: run.runId,
    }, revision, [{
      eventId: randomUUID(),
      type: 'proof:result-accepted',
      version: 1,
      timestamp: new Date().toISOString(),
      correlationId: run.runId,
      causationId: null,
      payload: {
        position,
        record: {
          ...record,
          result: { verdict: 'deny', confidence: 0.9 },
        },
      },
    }]);
    await expect(resolveAcceptedResult(
      run.reopen(),
      run.runId,
      position,
      binding,
    )).resolves.toMatchObject({ kind: 'wait' });
    await expect(resolveAcceptedResult(
      run.reopen(),
      run.runId,
      otherPosition,
      binding,
    )).resolves.toMatchObject({ kind: 'accepted' });
  });

  it('does not return an accepted result when its event append fails', async () => {
    const { reviewA: position } = await recordCompletedReviews();
    const failingStorage = rejectEventAppends(
      run.storage,
      new StorageError('STORAGE_LIMIT_EXCEEDED', 'fixture append failed'),
    );

    await expect(createAcceptedResultRecord(
      failingStorage,
      run.runId,
      position,
      { result: { verdict: 'pass' }, ...binding },
    )).rejects.toMatchObject({ code: 'STORAGE_LIMIT_EXCEEDED' });
    await expect(resolveAcceptedResult(
      run.reopen(),
      run.runId,
      position,
      binding,
    )).resolves.toMatchObject({ kind: 'wait' });
  });
});
