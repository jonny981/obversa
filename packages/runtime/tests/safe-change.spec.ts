import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyTarget, hashBytes, readRecordBytes, readTarget, replaceTarget, seedSafeChangeFixture, targetPath, targetStream, TargetWriteUncertain } from '../../../examples/safe-change/file-adapter.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'safe-change-'))); roots.push(directory);
  const input = await seedSafeChangeFixture(directory);
  return { directory, input };
}
describe('safe-change file adapter', () => {
  it.each(['open', 'sync', 'close'] as const)('classifies directory %s failure after replacement as an uncertain write', async (stage) => {
    const { directory, input } = await fixture();
    const destination = input.destinations[0]!;
    const before = await readRecordBytes(targetPath(directory, destination.id));
    const witness = { actionId: 'stored-attempt', proposalDigest: hashBytes('proposal'), beforeDigest: hashBytes(before), afterDigest: hashBytes(destination.content) };
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(open).mockImplementation(async (...args) => {
      if (String(args[0]) !== join(directory, 'targets')) return actual.open(...args);
      if (stage === 'open') throw new Error('Directory open failed after rename');
      const handle = await actual.open(...args);
      if (stage === 'sync') handle.sync = async () => { throw new Error('Directory sync failed after rename'); };
      if (stage === 'close') {
        const close = handle.close.bind(handle);
        handle.close = async () => { await close(); throw new Error('Directory close failed after rename'); };
      }
      return handle;
    });
    try {
      await expect(applyTarget(directory, destination, witness, async () => {}, {})).rejects.toBeInstanceOf(TargetWriteUncertain);
      expect(await readTarget(directory, destination.id)).toMatchObject({ revision: 2, content: destination.content, lastAction: witness });
    } finally { vi.mocked(open).mockImplementation(actual.open); }
  });

  it('refuses an oversized serialized target before changing its bytes or action witness', async () => {
    const { directory, input } = await fixture();
    const destination = { ...input.destinations[0]!, content: JSON.stringify([{ body: 'a'.repeat(40_000) }, { body: 'b'.repeat(40_000) }]) };
    const before = await readRecordBytes(targetPath(directory, destination.id));
    const witness = { actionId: 'stored-attempt', proposalDigest: hashBytes('proposal'), beforeDigest: hashBytes(before), afterDigest: hashBytes(destination.content) };
    await expect(applyTarget(directory, destination, witness, async () => {}, {})).rejects.toThrow(/64 KiB/);
    expect(await readRecordBytes(targetPath(directory, destination.id))).toBe(before);
    expect((await readTarget(directory, destination.id)).lastAction).toBeNull();
  });

  it('refuses a target whose embedded ID would redirect the atomic replacement', async () => {
    const { directory, input } = await fixture();
    const [destination, other] = input.destinations;
    const record = { ...await readTarget(directory, destination!.id), id: other!.id };
    const bytes = JSON.stringify(record);
    await writeFile(targetPath(directory, destination!.id), bytes);
    const otherBefore = await readRecordBytes(targetPath(directory, other!.id));
    await expect(applyTarget(directory, destination!, {
      actionId: 'stored-attempt', proposalDigest: hashBytes('proposal'), beforeDigest: hashBytes(bytes), afterDigest: hashBytes(destination!.content),
    }, async () => {}, {})).rejects.toThrow();
    expect(await readRecordBytes(targetPath(directory, other!.id))).toBe(otherBefore);
  });

  it('retains a UTF8 byte-order mark so capture cannot silently normalize original bytes', async () => {
    const { directory, input } = await fixture();
    const path = sourcePath(directory, input.sourceIds[0]!);
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await readFile(path)]);
    await writeFile(path, bytes);
    expect(Buffer.from(await readRecordBytes(path))).toEqual(bytes);
    const run = await openSafeChangeRun({ directory, runId: 'byte-order-mark', input });
    expect((await run.executor.run(new AbortController().signal)).kind).toBe('fail');
    expect((await readTarget(directory, input.destinations[0]!.id)).lastAction).toBeNull();
  });

  it('refuses invalid UTF8 source bytes instead of replacing them during capture', async () => {
    const { directory, input } = await fixture();
    const path = targetPath(directory, input.destinations[0]!.id);
    await writeFile(path, Buffer.from([0xff]));
    await expect(readRecordBytes(path)).rejects.toThrow();
  });

  it.each(['inactive', 'changed revision', 'changed bytes'] as const)('refuses %s before replacing the target', async (drift) => {
    const { directory, input } = await fixture();
    const destination = input.destinations[0]!;
    const original = await readRecordBytes(targetPath(directory, destination.id));
    const witness = { actionId: 'stored-attempt', proposalDigest: hashBytes('proposal'), beforeDigest: hashBytes(original), afterDigest: hashBytes(destination.content) };
    const record = await readTarget(directory, destination.id);
    await replaceTarget(directory, { ...record,
      ...(drift === 'inactive' ? { active: false } : drift === 'changed revision' ? { revision: 2 } : { content: '["foreign"]' }),
    });
    const before = await readRecordBytes(targetPath(directory, destination.id));
    await expect(applyTarget(directory, destination, witness, async () => {}, {})).rejects.toThrow();
    expect(await readRecordBytes(targetPath(directory, destination.id))).toBe(before);
  });
});

import { loadRunDefinition } from '@obversa/runtime';
import { sourcePath, sourceStream } from '../../../examples/safe-change/file-adapter.ts';
import { openSafeChangeRun } from '../../../examples/safe-change/recipe.ts';

describe('safe-change production line', () => {
  it.each(['source', 'target'] as const)('refuses a %s journal ID as the executor run stream', async (kind) => {
    const { directory, input } = await fixture();
    const runId = kind === 'source' ? sourceStream(input.sourceIds[0]!).streamId : targetStream(input.destinations[0]!.id).streamId;
    await expect(openSafeChangeRun({ directory, runId, input })).rejects.toThrow(/stream/);
    for (const destination of input.destinations) expect((await readTarget(directory, destination.id)).lastAction).toBeNull();
  });

  it('fails an approved aggregate over 64 KiB without changing either target', async () => {
    const { directory, input } = await fixture();
    const records = JSON.parse(input.destinations[0]!.content);
    for (const record of records) {
      record.body = 'protected'.repeat(5_000);
      await writeFile(sourcePath(directory, record.id), JSON.stringify(record));
    }
    const changed = { ...input, destinations: input.destinations.map((target, index) => index === 0 ? { ...target, content: JSON.stringify(records) } : target) };
    const before = await Promise.all(input.destinations.map((target) => readRecordBytes(targetPath(directory, target.id))));
    const run = await openSafeChangeRun({ directory, runId: 'oversized-aggregate', input: changed });
    expect((await run.executor.run(new AbortController().signal)).kind).toBe('pause');
    await run.approve();
    expect((await run.executor.resume(run.approvalPosition, new AbortController().signal)).kind).toBe('fail');
    expect(await Promise.all(input.destinations.map((target) => readFile(targetPath(directory, target.id), 'utf8')))).toEqual(before);
    for (const target of input.destinations) expect((await readTarget(directory, target.id)).lastAction).toBeNull();
  });

  it('binds exact target file permission to the stored plan and approval subject', async () => {
    const { directory, input } = await fixture();
    const run = await openSafeChangeRun({ directory, runId: 'permissions', input });
    const expected = [{ name: 'workspace.write', scope: { paths: input.destinations.map((target) => targetPath(directory, target.id)) } }];
    expect((await loadRunDefinition(run.storage, 'permissions')).resolvedPlan.plan.permissions.admitted).toEqual(expected);
    expect((await run.executor.run(new AbortController().signal)).kind).toBe('pause');
    await run.requestApproval();
    const events = [];
    for await (const event of run.storage.eventStore.read({ namespace: 'safe-change', streamId: 'permissions' })) events.push(event);
    const subject = events.map((event) => event.payload as Record<string, any>).find((payload) => payload.approvalSubject)?.approvalSubject;
    expect(subject.effectivePermissions).toEqual(expected);
  });

  it('refuses a reused source event identity with different payload', async () => {
    const { directory, input } = await fixture();
    const runId = 'collision';
    const run = await openSafeChangeRun({ directory, runId, input });
    const sourceId = input.sourceIds[0]!;
    await run.storage.eventStore.append(sourceStream(sourceId), 0, [{
      eventId: hashBytes(`${runId}:safe-change:source-recorded:${sourceId}`), type: 'safe-change:source-recorded', version: 1,
      timestamp: new Date().toISOString(), correlationId: runId, causationId: null, payload: { sourceId, record: {} },
    }]);
    expect((await run.executor.run(new AbortController().signal)).kind).toBe('fail');
  });

  it.each(['missing mapping', 'lost metadata', 'lost body bytes'] as const)('rejects %s before approval or outward action', async (invalid) => {
    const { directory, input } = await fixture();
    const records = JSON.parse(input.destinations[0]!.content);
    if (invalid === 'lost metadata') delete records[0].metadata.author;
    if (invalid === 'lost body bytes') records[0].body = records[0].body.replace('café', 'cafe');
    const changed = { ...input,
      mappings: invalid === 'missing mapping' ? input.mappings.slice(1) : input.mappings,
      destinations: input.destinations.map((target, index) => index === 0 ? { ...target, content: JSON.stringify(records) } : target),
    };
    const run = await openSafeChangeRun({ directory, runId: 'invalid-change', input: changed });
    expect((await run.executor.run(new AbortController().signal)).kind).toBe('fail');
    expect((await readTarget(directory, input.destinations[0]!.id)).revision).toBe(1);
  });

  it('keeps every target unchanged when the approval attempt is resumed without a stored allow', async () => {
    const { directory, input } = await fixture();
    const original = await Promise.all(input.destinations.map((target) => readRecordBytes(targetPath(directory, target.id))));
    const run = await openSafeChangeRun({ directory, runId: 'missing-approval', input });
    expect((await run.executor.run(new AbortController().signal)).kind).toBe('pause');
    await run.requestApproval();
    const reopened = await openSafeChangeRun({ directory, runId: 'missing-approval' });
    expect((await reopened.executor.resume(reopened.approvalPosition, new AbortController().signal)).kind).toBe('pause');
    expect(await Promise.all(input.destinations.map((target) => readRecordBytes(targetPath(directory, target.id))))).toEqual(original);
  });

  it('applies approved whole records through recorded attempts and verified backups', async () => {
    const { directory, input } = await fixture();
    const run = await openSafeChangeRun({ directory, runId: 'safe-change', input });
    expect((await run.executor.run(new AbortController().signal)).kind).toBe('pause');
    const request = await run.requestApproval();
    await run.approve();
    expect((await run.executor.resume(run.approvalPosition, new AbortController().signal)).kind).toBe('complete');
    for (const destination of input.destinations) {
      const target = await readTarget(directory, destination.id);
      expect(target.content).toBe(destination.content);
      expect(target.revision).toBe(2);
      expect(target.lastAction?.actionId).toMatch(/^sha256:/);
      const history = [];
      for await (const event of run.storage.eventStore.read(targetStream(destination.id))) history.push(event);
      expect(history.find((event) => event.type === 'safe-change:intent')?.payload).toMatchObject({
        approvalRequestId: request.requestId, approvalRequestDigest: request.digest,
      });
    }
  });
});
