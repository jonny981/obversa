import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../src/api.js';
import { canonicalJson, digestJson, type JsonValue } from '../src/graph/value.js';
import { appendRunEvent, readRunEvents } from '../src/runtime/run-event.js';
import { createStoredRunFixture, type StoredRunFixture } from './stored-run-fixture.js';

// Real work: these tests write files to temporary directories on disk, so
// this file declares its own time limit; the suite default is a hang guard,
// not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let run: StoredRunFixture;
let directory: string;

beforeEach(async () => {
  run = await createStoredRunFixture('proof-cache');
  directory = await realpath(await mkdtemp(join(tmpdir(), 'obversa-proof-sources-')));
});

async function completedProof() {
  const source = await fileSource('document', { body: 'Full proof — ✓', metadata: { protected: true } });
  const options = {
    storage: run.storage, runId: run.runId, sources: [source],
    proofJobs: [job('review', ['document'])], maxPacketBytes: 4096,
  };
  const cache = api.createProofCache(options);
  const stored = await api.loadRunDefinition(run.storage, run.runId);
  const graph = api.compileGraph(api.dagGraphType, stored.record.payload.definition.graphDefinition.value as api.DagDefinition);
  const prove = vi.fn(async () => {
    const evidence = await cache.packet('review');
    return { checked: evidence.inputHashes.document!, passed: evidence.packet.sources.length === 1 };
  });
  const node: api.GraphNodeBinding = {
    prompt: null,
    scratchDirectory: directory,
    workspace: { mode: 'none', directory: null, allowedPaths: [] },
    trustedCaller: {}, permissions: [],
    policy: {
      inputBytes: 100_000, outputBytes: 100_000, timeoutMs: 5000, teardownGraceMs: 100,
      memoryBytes: 100_000_000, filesChanged: 0, linesChanged: 0, callTokens: null,
    },
    resultContract: null, runData: prove, parseResult: null, tokenBudget: null,
    decideAction: async () => ({ kind: 'allow' }),
  };
  const executor = await api.createGraphExecutor({
    runId: run.runId, graph, storage: run.storage,
    nodes: { 'review-a': node, 'review-b': node }, engines: [],
  });
  const outcome = await executor.run(new AbortController().signal);
  expect(outcome).toMatchObject({ kind: 'complete' });
  const position = 'dag/review-a/1';
  const events = await readRunEvents(run.storage, run.runId);
  const completion = events.events.find((event) => event.type === 'graph:node-completed'
    && (event.payload as api.JsonObject).position === position)!;
  const current = {
    graph: { definitionDigest: graph.definition.digest, typeVersion: graph.describe().graph.typeVersion },
    workspaceAnchor: {
      schemaVersion: 1 as const, root: directory, repositoryId: join(directory, '.git'),
      head: 'a'.repeat(40), fingerprint: 'b'.repeat(64), scope: null, files: [],
    },
    reviewerIdentity: { adapter: 'fixture', provider: 'reviewer-a', modelFamily: 'review', model: '1' },
  };
  const evidence = await cache.packet('review');
  const record = await api.createAcceptedResultRecord(run.storage, run.runId, position, {
    ...current, ...evidence, result: (completion.payload as api.JsonObject).result!,
  });
  return { source, options, cache, current, evidence, record, position, prove, completion };
}

describe('cached proof accepted-result resolution', () => {
  it('reuses one real completed proof through storage without rereading unchanged payloads', async () => {
    const proof = await completedProof();
    const first = await proof.cache.resolveAccepted('review', proof.position, proof.current);
    const freshReviewer = () => proof.cache.resolveAccepted('review', proof.position, { ...proof.current });
    expect(first).toEqual({ kind: 'accepted', record: proof.record });
    expect(await freshReviewer()).toEqual(first);
    expect(proof.source.read).toHaveBeenCalledTimes(1);
    expect(proof.prove).toHaveBeenCalledTimes(2);
    const events = await readRunEvents(run.reopen(), run.runId);
    expect(events.events.filter((event) => event.type === 'proof:result-accepted')).toHaveLength(1);
    const reopened = api.createProofCache({ ...proof.options, storage: run.reopen() });
    expect(await reopened.resolveAccepted('review', proof.position, proof.current)).toEqual(first);
    expect(proof.source.read).toHaveBeenCalledTimes(2);
  });

  it('refuses changed current bindings and derives evidence instead of trusting caller-supplied old hashes', async () => {
    const proof = await completedProof();
    expect((await proof.cache.resolveAccepted('review', proof.position, proof.current)).kind).toBe('accepted');
    for (const current of [
      { ...proof.current, reviewerIdentity: { ...proof.current.reviewerIdentity, provider: 'reviewer-b' } },
      { ...proof.current, graph: { ...proof.current.graph, definitionDigest: digestJson('different graph') } },
      { ...proof.current, workspaceAnchor: { ...proof.current.workspaceAnchor, fingerprint: 'c'.repeat(64) } },
    ]) {
      expect((await proof.cache.resolveAccepted('review', proof.position, current)).kind).toBe('wait');
    }
    const changedScope = api.createProofCache({
      ...proof.options, proofJobs: [{ ...job('review', ['document']), proofScope: { review: 'different scope' } }],
    });
    expect((await changedScope.resolveAccepted('review', proof.position, proof.current)).kind).toBe('wait');
    await proof.source.update({ body: 'Changed proof', metadata: { protected: true } });
    const falseBinding = { ...proof.current, ...proof.evidence };
    expect((await proof.cache.resolveAccepted('review', proof.position, falseBinding)).kind).toBe('wait');
  });

  it.each(['accepted record', 'completion'])('checks stored %s conflicts again after an accepted hit', async (kind) => {
    const proof = await completedProof();
    expect((await proof.cache.resolveAccepted('review', proof.position, proof.current)).kind).toBe('accepted');
    await appendRunEvent(run.storage, run.runId, {
      eventId: randomUUID(), version: 1, timestamp: new Date().toISOString(),
      correlationId: run.runId, causationId: null,
      type: kind === 'accepted record' ? 'proof:result-accepted' : 'graph:node-completed',
      payload: kind === 'accepted record' ? { position: proof.position, record: proof.record } : proof.completion.payload,
    });
    expect((await proof.cache.resolveAccepted('review', proof.position, proof.current)).kind).toBe('wait');
    expect(proof.source.read).toHaveBeenCalledTimes(1);
  });

  it('captures current identity before waiting for a source revision', async () => {
    const proof = await completedProof();
    const entered = deferred();
    const release = deferred();
    const realRevision = proof.source.revision.getMockImplementation()!;
    proof.source.revision.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return realRevision();
    });
    const lookup = proof.cache.resolveAccepted('review', proof.position, proof.current);
    await entered.promise;
    proof.current.reviewerIdentity.provider = 'changed while waiting';
    release.resolve();
    expect(await lookup).toEqual({ kind: 'accepted', record: proof.record });
    expect((await proof.cache.resolveAccepted('review', proof.position, proof.current)).kind).toBe('wait');
  });
});

afterEach(async () => {
  await run.close();
  await rm(directory, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fileSource(id: string, content: JsonValue) {
  const path = join(directory, `${id}.json`);
  const revisionPath = join(directory, `${id}.revision`);
  let nextRevision = 0;
  const update = async (value: JsonValue) => {
    await writeFile(path, JSON.stringify(value));
    await writeFile(revisionPath, String(++nextRevision));
  };
  await update(content);
  const revision = vi.fn(() => readFile(revisionPath, 'utf8'));
  const read = vi.fn(async (expectedRevision: string, maxBytes: number): Promise<JsonValue> => {
    if (await revision() !== expectedRevision) throw new Error('source revision changed');
    const bytes = await readFile(path);
    if (bytes.byteLength > maxBytes) throw new Error('source exceeds maxBytes');
    if (await revision() !== expectedRevision) throw new Error('source revision changed');
    return JSON.parse(bytes.toString()) as JsonValue;
  });
  return { id, revision, read, update };
}

const job = (id: string, sourceIds: readonly string[]) => ({
  id, sourceIds, mode: 'read-only' as const, proofScope: { review: id },
});

describe('host proof packet cache', () => {
  it('shares complete immutable file evidence between concurrent fresh consumers', async () => {
    const content = { title: 'Résumé — ✓', body: '| A | B |\n```ts\nconst x = "£";\n```', metadata: { keep: true } };
    const source = await fileSource('document', content);
    const entered = deferred();
    const release = deferred();
    const realRead = source.read.getMockImplementation()!;
    source.read.mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return realRead(...args);
    });
    const cache = api.createProofCache({
      storage: run.storage, runId: run.runId, sources: [source],
      proofJobs: [job('writer', ['document']), job('reviewer', ['document'])], maxPacketBytes: 4096,
    });
    const first = cache.packet('writer');
    await entered.promise;
    const second = cache.packet('reviewer');
    release.resolve();
    const [writer, reviewer] = await Promise.all([first, second]);
    expect(source.read).toHaveBeenCalledTimes(1);
    expect(source.read).toHaveBeenCalledWith('1', 4096);
    expect(reviewer.proofArtifact).toEqual(writer.proofArtifact);
    expect(writer.packet.sources).toEqual([{ id: 'document', revision: '1', digest: digestJson(content), content }]);
    expect(writer.inputHashes).toEqual({ document: digestJson(content) });
    expect(writer.proofScope).toEqual({ review: 'writer' });
    expect(Object.isFrozen(writer.packet.sources[0]!.content)).toBe(true);
    expect(Object.isFrozen(writer.inputHashes)).toBe(true);
    const bytes = await run.reopen().artifactStore.read(
      { namespace: run.storage.record.namespace, runId: run.runId }, writer.proofArtifact,
    );
    expect(Buffer.from(bytes).toString()).toBe(canonicalJson(writer.packet));
    expect(await cache.packet('writer')).toBe(writer);
    expect(source.read).toHaveBeenCalledTimes(1);
  });

  it('invalidates only dependent packets and treats a new revision as new evidence', async () => {
    const a = await fileSource('a', 'first');
    const b = await fileSource('b', 'shared');
    const c = await fileSource('c', 'independent');
    const cache = api.createProofCache({
      storage: run.storage, runId: run.runId, sources: [a, b, c],
      proofJobs: [job('ab', ['a', 'b']), job('bc', ['b', 'c'])], maxPacketBytes: 4096,
    });
    const ab = await cache.packet('ab');
    const bc = await cache.packet('bc');
    await a.update('changed');
    const changed = await cache.packet('ab');
    expect(changed.proofArtifact.digest).not.toBe(ab.proofArtifact.digest);
    expect(changed.inputHashes.a).toBe(digestJson('changed'));
    expect(await cache.packet('bc')).toBe(bc);
    await a.update('changed');
    const revised = await cache.packet('ab');
    expect(revised.inputHashes).toEqual(changed.inputHashes);
    expect(revised.proofArtifact.digest).not.toBe(changed.proofArtifact.digest);
    expect(a.read).toHaveBeenCalledTimes(3);
    expect(b.read).toHaveBeenCalledTimes(1);
    expect(c.read).toHaveBeenCalledTimes(1);
  });

  it('refuses effectful and unknown jobs before looking at any source', async () => {
    const source = await fileSource('a', 'source');
    const cache = api.createProofCache({
      storage: run.storage, runId: run.runId, sources: [source],
      proofJobs: [{ ...job('apply', ['a']), mode: 'effectful' }], maxPacketBytes: 4096,
    });
    await expect(cache.packet('apply')).rejects.toThrow(/read-only/);
    await expect(cache.packet('unknown')).rejects.toThrow(/unknown proof job/);
    expect(source.revision).not.toHaveBeenCalled();
    expect(source.read).not.toHaveBeenCalled();
  });

  it('captures declarations instead of letting callers change eligibility or scope', async () => {
    const source = await fileSource('a', 'source');
    const declaration = { ...job('review', ['a']), sourceIds: ['a'] };
    const cache = api.createProofCache({
      storage: run.storage, runId: run.runId, sources: [source],
      proofJobs: [declaration], maxPacketBytes: 4096,
    });
    declaration.sourceIds.push('undeclared');
    declaration.proofScope.review = 'changed';
    expect((await cache.packet('review')).proofScope).toEqual({ review: 'review' });
  });

  it('bounds the full stored packet in UTF-8 bytes without truncating content', async () => {
    const source = await fileSource('a', 'é✓'.repeat(20));
    const options = { storage: run.storage, runId: run.runId, sources: [source], proofJobs: [job('review', ['a'])] };
    const original = await api.createProofCache({ ...options, maxPacketBytes: 4096 }).packet('review');
    const limit = original.proofArtifact.byteLength;
    const exact = await api.createProofCache({ ...options, maxPacketBytes: limit }).packet('review');
    expect(exact.packet).toEqual(original.packet);
    const write = vi.spyOn(run.storage.artifactStore, 'write');
    await expect(api.createProofCache({ ...options, maxPacketBytes: limit - 1 }).packet('review'))
      .rejects.toThrow(/maxPacketBytes/);
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses a changed revision during capture and does not replace newer cached evidence', async () => {
    const source = await fileSource('a', 'old');
    const entered = deferred();
    const release = deferred();
    const realRead = source.read.getMockImplementation()!;
    source.read.mockImplementationOnce(async (...args) => {
      const value = await realRead(...args);
      entered.resolve();
      await release.promise;
      return value;
    });
    const cache = api.createProofCache({
      storage: run.storage, runId: run.runId, sources: [source],
      proofJobs: [job('review', ['a'])], maxPacketBytes: 4096,
    });
    const old = cache.packet('review');
    const refused = expect(old).rejects.toThrow(/revision changed/);
    await entered.promise;
    await source.update('new');
    const current = await cache.packet('review');
    release.resolve();
    await refused;
    expect(current.inputHashes.a).toBe(digestJson('new'));
    expect(await cache.packet('review')).toBe(current);
    expect(source.read).toHaveBeenCalledTimes(2);
  });

  it('does not let a delayed old revision probe evict a newer packet', async () => {
    const source = await fileSource('a', 'old');
    const entered = deferred();
    const release = deferred();
    const realRevision = source.revision.getMockImplementation()!;
    source.revision.mockImplementationOnce(async () => {
      const value = await realRevision();
      entered.resolve();
      await release.promise;
      return value;
    });
    const cache = api.createProofCache({
      storage: run.storage, runId: run.runId, sources: [source],
      proofJobs: [job('review', ['a'])], maxPacketBytes: 4096,
    });
    const old = cache.packet('review');
    const refused = expect(old).rejects.toThrow(/revision changed/);
    await entered.promise;
    await source.update('new');
    const current = await cache.packet('review');
    release.resolve();
    await refused;
    expect(await cache.packet('review')).toBe(current);
    expect(source.read).toHaveBeenCalledTimes(1);
  });

  it('retries a failed capture and a failed artifact append without returning partial proof', async () => {
    const source = await fileSource('a', 'complete');
    source.read.mockRejectedValueOnce(new Error('read unavailable'));
    const cache = api.createProofCache({
      storage: run.storage, runId: run.runId, sources: [source],
      proofJobs: [job('review', ['a'])], maxPacketBytes: 4096,
    });
    await expect(cache.packet('review')).rejects.toThrow('read unavailable');
    const write = vi.spyOn(run.storage.artifactStore, 'write');
    write.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(cache.packet('review')).rejects.toThrow('storage unavailable');
    const packet = await cache.packet('review');
    expect(packet.inputHashes.a).toBe(digestJson('complete'));
    expect(source.read).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid limits and declarations at construction', async () => {
    const source = await fileSource('a', 'source');
    const options = { storage: run.storage, runId: run.runId, sources: [source], proofJobs: [job('review', ['a'])], maxPacketBytes: 4096 };
    for (const maxPacketBytes of [0, -1, 1.5, Infinity, NaN]) {
      expect(() => api.createProofCache({ ...options, maxPacketBytes })).toThrow(/maxPacketBytes/);
    }
    expect(() => api.createProofCache({ ...options, sources: [source, source] })).toThrow(/duplicate source/);
    expect(() => api.createProofCache({ ...options, proofJobs: [job('review', ['missing'])] })).toThrow(/unknown source/);
    expect(() => api.createProofCache({ ...options, proofJobs: [job('review', ['a', 'a'])] })).toThrow(/duplicate source/);
    expect(() => api.createProofCache({ ...options, proofJobs: [job('review', ['a']), job('review', ['a'])] })).toThrow(/duplicate proof job/);
  });
});
