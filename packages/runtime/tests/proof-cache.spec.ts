import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../src/api.js';
import { canonicalJson, digestJson, type JsonValue } from '../src/graph/value.js';
import { createStoredRunFixture, type StoredRunFixture } from './stored-run-fixture.js';

let run: StoredRunFixture;
let directory: string;

beforeEach(async () => {
  run = await createStoredRunFixture('proof-cache');
  directory = await mkdtemp(join(tmpdir(), 'obversa-proof-sources-'));
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
