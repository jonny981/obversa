import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLocalArtifactStore } from '../src/artifacts/file-store.js';
import type {
  ArtifactBatch,
  ArtifactReference,
  ArtifactScope,
  ArtifactStore,
  NewArtifact,
} from '../src/artifacts/store.js';
import { StorageError } from '../src/storage/error.js';

const roots: string[] = [];
const decoder = new TextDecoder();
const scope: ArtifactScope = { namespace: 'host-one', runId: 'run-one' };
const OVERSIZED_FILE_BYTES = 1_048_576;

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'obversa-artifacts-'));
  roots.push(path);
  return path;
}

function writeRequest(
  text: string,
  overrides: Partial<NewArtifact> = {},
): NewArtifact {
  return {
    bytes: new TextEncoder().encode(text),
    mediaType: 'text/plain',
    purpose: 'node-output',
    contentMode: 'exact',
    ...overrides,
  };
}

async function files(directory: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else output.push(child);
    }
  }
  await walk(directory);
  return output.sort();
}

async function rawBytes(directory: string): Promise<Buffer> {
  const chunks = await Promise.all((await files(directory)).map((path) => readFile(path)));
  return Buffer.concat(chunks);
}

async function fileContaining(
  directory: string,
  text: string,
): Promise<string | undefined> {
  for (const path of await files(directory)) {
    if ((await readFile(path)).includes(Buffer.from(text))) return path;
  }
  return undefined;
}

async function expectCode(
  operation: Promise<unknown>,
  code: string,
): Promise<StorageError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(StorageError);
    expect(error).toMatchObject({ code });
    return error as StorageError;
  }
  throw new Error(`Expected ${code}.`);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe('local artifact storage', () => {
  it('commits content-addressed bytes and returns detached reads', async () => {
    const directory = await root();
    const store = createLocalArtifactStore({ root: directory });
    const source = new TextEncoder().encode('hello');
    const reference = await store.write(scope, writeRequest('hello', { bytes: source }));

    expect(reference).toEqual({
      schemaVersion: 1,
      digest: 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      byteLength: 5,
      mediaType: 'text/plain',
      purpose: 'node-output',
    });
    source[0] = 0;

    const first = await store.read(scope, reference);
    first[0] = 0;
    const second = await store.read(scope, reference);

    expect(decoder.decode(second)).toBe('hello');
    expect((await files(directory)).some((path) =>
      basename(path).startsWith('.tmp-'))).toBe(false);
  });

  it('changes the address when one byte changes', async () => {
    const store = createLocalArtifactStore({ root: await root() });

    const first = await store.write(scope, writeRequest('hello'));
    const second = await store.write(scope, writeRequest('hellp'));

    expect(first.digest).not.toBe(second.digest);
  });

  it('isolates identical references by namespace and run', async () => {
    const store = createLocalArtifactStore({ root: await root() });
    const reference = await store.write(scope, writeRequest('same bytes'));

    await expectCode(store.read({
      namespace: 'host-two',
      runId: 'run-one',
    }, reference), 'ARTIFACT_NOT_ADMITTED');
    await expectCode(store.read({
      namespace: 'host-one',
      runId: 'run-two',
    }, reference), 'ARTIFACT_NOT_ADMITTED');
  });

  it('rejects sensitive and secret-bearing exact bytes without admitting them', async () => {
    const directory = await root();
    const secret = 'known-secret-value';
    const store = createLocalArtifactStore({
      root: directory,
      knownSecrets: [secret],
    });

    await expectCode(store.write(scope, writeRequest('ordinary', { sensitive: true })), 'SENSITIVE_CONTENT');
    await expectCode(store.write(scope, writeRequest(`token=${secret}`)), 'KNOWN_SECRET');

    expect((await rawBytes(directory)).includes(Buffer.from('ordinary'))).toBe(false);
    expect((await rawBytes(directory)).includes(Buffer.from(secret))).toBe(false);
  });

  it('redacts declared free text before hashing and sizing', async () => {
    const secret = 'known-secret-value';
    const store = createLocalArtifactStore({
      root: await root(),
      knownSecrets: [secret],
    });

    const reference = await store.write(scope, writeRequest(`token=${secret}`, {
      contentMode: 'free-text',
    }));
    const bytes = await store.read(scope, reference);
    const expected = 'token=[redacted]';

    expect(decoder.decode(bytes)).toBe(expected);
    expect(reference.byteLength).toBe(Buffer.byteLength(expected));
    expect(reference.digest).toBe(
      `sha256:${createHash('sha256').update(expected).digest('hex')}`,
    );
  });

  it('accepts and redacts a well-formed Unicode secret', async () => {
    const store = createLocalArtifactStore({
      root: await root(),
      knownSecrets: ['🔐token'],
    });

    const reference = await store.write(scope, writeRequest('value=🔐token', {
      contentMode: 'free-text',
    }));

    expect(decoder.decode(await store.read(scope, reference))).toBe(
      'value=[redacted]',
    );
  });

  it('rejects invalid UTF-8 declared as free text', async () => {
    const store = createLocalArtifactStore({ root: await root() });

    await expectCode(store.write(scope, {
      bytes: Uint8Array.of(0xff),
      mediaType: 'text/plain',
      purpose: 'model-output',
      contentMode: 'free-text',
    }), 'INVALID_STORED_VALUE');
  });

  it('rejects known secrets in state artifacts', async () => {
    const store = createLocalArtifactStore({
      root: await root(),
      knownSecrets: ['known-secret-value'],
    });

    await expectCode(store.write(scope, writeRequest('{"token":"known-secret-value"}', {
      mediaType: 'application/json',
      contentMode: 'state',
    })), 'KNOWN_SECRET');
  });

  it.each([
    ['value', 'application/json', JSON.stringify({ token: 'line\nbreak' })],
    ['key', 'application/json', JSON.stringify({ 'line\nbreak': 'safe' })],
    ['value in structured JSON', 'application/problem+json', JSON.stringify({
      token: 'line\nbreak',
    })],
  ])('rejects a known secret in an escaped JSON %s', async (_position, mediaType, json) => {
    const directory = await root();
    const store = createLocalArtifactStore({
      root: directory,
      knownSecrets: ['line\nbreak'],
    });

    await expectCode(store.write(scope, writeRequest(json, {
      mediaType,
      contentMode: 'state',
    })), 'KNOWN_SECRET');
    expect((await files(directory))).toEqual([]);
  });

  it('rejects invalid JSON declared as JSON state', async () => {
    const store = createLocalArtifactStore({ root: await root() });

    await expectCode(store.write(scope, writeRequest('{"open":', {
      mediaType: 'application/json',
      contentMode: 'state',
    })), 'INVALID_STORED_VALUE');
  });

  it('keeps non-JSON state as exact bytes', async () => {
    const store = createLocalArtifactStore({ root: await root() });

    const reference = await store.write(scope, writeRequest('{"open":', {
      mediaType: 'application/octet-stream',
      contentMode: 'state',
    }));

    expect(decoder.decode(await store.read(scope, reference))).toBe('{"open":');
  });

  it('rejects a known secret in stored artifact metadata', async () => {
    const directory = await root();
    const secret = 'super"secret\\token';
    const store = createLocalArtifactStore({
      root: directory,
      knownSecrets: [secret],
    });

    const request = writeRequest('safe bytes', {
      purpose: secret,
    });
    await expectCode(store.preflightWrite(scope, [request]), 'KNOWN_SECRET');
    await expectCode(store.write(scope, request), 'KNOWN_SECRET');
    expect((await rawBytes(directory)).includes(Buffer.from(secret))).toBe(false);
  });

  it('screens the complete admission record, including its checksum', async () => {
    const sourceDirectory = await root();
    const source = createLocalArtifactStore({ root: sourceDirectory });
    const firstRequest = writeRequest('first bytes');
    const secondRequest = writeRequest('second bytes');
    await source.write(scope, firstRequest);
    const secondReference = await source.write(scope, secondRequest);
    const recordPath = await fileContaining(sourceDirectory, secondReference.digest);
    expect(recordPath).toBeDefined();
    const record = JSON.parse(await readFile(recordPath!, 'utf8')) as {
      checksum: string;
    };

    const targetDirectory = await root();
    const target = createLocalArtifactStore({
      root: targetDirectory,
      knownSecrets: [record.checksum],
    });

    await expectCode(target.preflightWrite(scope, [
      firstRequest,
      secondRequest,
    ]), 'KNOWN_SECRET');
    expect(await files(targetDirectory)).toEqual([]);
    await target.write(scope, firstRequest);
    await expectCode(target.write(scope, secondRequest), 'KNOWN_SECRET');
    expect((await rawBytes(targetDirectory)).includes(Buffer.from(record.checksum))).toBe(false);
  });

  it('rejects free-text redaction when the replacement is also a known secret', async () => {
    const directory = await root();
    const store = createLocalArtifactStore({
      root: directory,
      knownSecrets: ['source-secret', '[redacted]'],
    });

    await expectCode(store.write(scope, writeRequest('source-secret', {
      contentMode: 'free-text',
    })), 'KNOWN_SECRET');
    expect(await files(directory)).toEqual([]);
  });

  it('preflights a batch without making bytes visible or reserving quota', async () => {
    const directory = await root();
    const store = createLocalArtifactStore({
      root: directory,
      maxArtifactBytes: 3,
      maxTotalArtifactBytesPerRun: 3,
    });

    const [predicted] = await store.preflightWrite(scope, [writeRequest('one')]);

    expect(await files(directory)).toEqual([]);
    await expectCode(store.read(scope, predicted!), 'ARTIFACT_NOT_ADMITTED');
    await expect(store.write(scope, writeRequest('two'))).resolves.toEqual(
      expect.objectContaining({ byteLength: 3 }),
    );
  });

  it('rejects an empty preflight batch', async () => {
    const store = createLocalArtifactStore({ root: await root() });

    await expectCode(
      store.preflightWrite(scope, [] as unknown as ArtifactBatch),
      'INVALID_STORED_VALUE',
    );
  });

  it('models cumulative quota for a whole preflight batch without partial admission', async () => {
    const directory = await root();
    const store = createLocalArtifactStore({
      root: directory,
      maxArtifactBytes: 3,
      maxTotalArtifactBytesPerRun: 5,
    });

    await expectCode(store.preflightWrite(scope, [
      writeRequest('aaa'),
      writeRequest('bbb'),
    ]), 'STORAGE_LIMIT_EXCEEDED');
    expect(await files(directory)).toEqual([]);
    await expect(store.write(scope, writeRequest('aaa'))).resolves.toBeDefined();
    await expect(store.write(scope, writeRequest('bb'))).resolves.toBeDefined();
  });

  it('returns the exact references that later writes issue', async () => {
    const store = createLocalArtifactStore({
      root: await root(),
      knownSecrets: ['known-secret-value'],
    });
    const requests = [
      writeRequest('token=known-secret-value', { contentMode: 'free-text' }),
      writeRequest('same', { purpose: 'first-use' }),
      writeRequest('same', { purpose: 'second-use' }),
    ] as const;

    const predicted = await store.preflightWrite(scope, requests);
    const issued = [];
    for (const request of requests) issued.push(await store.write(scope, request));

    expect(predicted).toEqual(issued);
    expect(Object.isFrozen(predicted)).toBe(true);
  });

  it('rejects a corrupt same-digest blob before a batch can admit its first item', async () => {
    const directory = await root();
    const store = createLocalArtifactStore({ root: directory });
    const existing = await store.write(scope, writeRequest('shared', {
      purpose: 'first-use',
    }));
    const existingBlob = (await files(directory)).find((path) =>
      path.endsWith(existing.digest.slice('sha256:'.length)));
    expect(existingBlob).toBeDefined();
    await chmod(existingBlob!, 0o600);
    await writeFile(existingBlob!, 'broken');
    await chmod(existingBlob!, 0o400);

    const batch = [
      writeRequest('first'),
      writeRequest('shared', { purpose: 'second-use' }),
    ] as const;
    const firstBytes = batch[0].bytes;
    const firstReference: ArtifactReference = {
      schemaVersion: 1,
      digest: `sha256:${createHash('sha256').update(firstBytes).digest('hex')}`,
      byteLength: firstBytes.byteLength,
      mediaType: batch[0].mediaType,
      purpose: batch[0].purpose,
    };
    const preflightThenWrite = async () => {
      await store.preflightWrite(scope, batch);
      for (const request of batch) await store.write(scope, request);
    };

    await expectCode(preflightThenWrite(), 'ARTIFACT_INTEGRITY');
    await expectCode(store.read(scope, firstReference), 'ARTIFACT_NOT_ADMITTED');
  });

  it('rejects a missing admitted blob before a batch can admit its first item', async () => {
    const directory = await root();
    const store = createLocalArtifactStore({ root: directory });
    const existing = await store.write(scope, writeRequest('saved'));
    const existingBlob = (await files(directory)).find((path) =>
      path.endsWith(existing.digest.slice('sha256:'.length)));
    expect(existingBlob).toBeDefined();
    await unlink(existingBlob!);

    const batch = [writeRequest('first'), writeRequest('saved')] as const;
    const firstBytes = batch[0].bytes;
    const firstReference: ArtifactReference = {
      schemaVersion: 1,
      digest: `sha256:${createHash('sha256').update(firstBytes).digest('hex')}`,
      byteLength: firstBytes.byteLength,
      mediaType: batch[0].mediaType,
      purpose: batch[0].purpose,
    };
    const preflightThenWrite = async () => {
      await store.preflightWrite(scope, batch);
      for (const request of batch) await store.write(scope, request);
    };

    await expectCode(preflightThenWrite(), 'ARTIFACT_NOT_FOUND');
    await expectCode(store.read(scope, firstReference), 'ARTIFACT_NOT_ADMITTED');
  });

  it('rejects a corrupt unadmitted crash blob during preflight', async () => {
    const directory = await root();
    const store = createLocalArtifactStore({ root: directory });
    const seed = await store.write(scope, writeRequest('seed'));
    const seedBlob = (await files(directory)).find((path) =>
      path.endsWith(seed.digest.slice('sha256:'.length)));
    expect(seedBlob).toBeDefined();

    const request = writeRequest('target');
    const targetDigest = createHash('sha256').update(request.bytes).digest('hex');
    const orphan = join(dirname(seedBlob!), targetDigest);
    await writeFile(orphan, 'broken', { mode: 0o400 });

    await expectCode(store.preflightWrite(scope, [request]), 'ARTIFACT_INTEGRITY');
  });

  it('enforces exact item and per-run total byte limits', async () => {
    const store = createLocalArtifactStore({
      root: await root(),
      maxArtifactBytes: 5,
      maxTotalArtifactBytesPerRun: 8,
    });

    const first = await store.write(scope, writeRequest('12345'));
    await expectCode(store.write(scope, writeRequest('123456')), 'STORAGE_LIMIT_EXCEEDED');
    await expectCode(store.write(scope, writeRequest('6789')), 'STORAGE_LIMIT_EXCEEDED');

    const duplicate = await store.write(scope, writeRequest('12345', {
      mediaType: 'application/octet-stream',
      purpose: 'same-content-new-use',
    }));
    expect(duplicate.digest).toBe(first.digest);
    expect(duplicate.mediaType).toBe('application/octet-stream');

    const last = await store.write(scope, writeRequest('678'));
    expect(last.byteLength).toBe(3);
  });

  it('admits at most one concurrent write when only one fits the quota', async () => {
    const directory = await root();
    const first = createLocalArtifactStore({
      root: directory,
      maxArtifactBytes: 5,
      maxTotalArtifactBytesPerRun: 5,
    });
    const second = createLocalArtifactStore({
      root: directory,
      maxArtifactBytes: 5,
      maxTotalArtifactBytesPerRun: 5,
    });

    const results = await Promise.allSettled([
      first.write(scope, writeRequest('aaa')),
      second.write(scope, writeRequest('bbb')),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((result) => result.status === 'rejected');
    expect(failure).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'STORAGE_LIMIT_EXCEEDED' }),
    });
  });

  it('ignores an orphaned old lock instead of wedging the run', async () => {
    const directory = await root();
    const store = createLocalArtifactStore({ root: directory });
    const first = await store.write(scope, writeRequest('one'));
    const object = (await files(directory)).find((path) =>
      path.endsWith(first.digest.slice('sha256:'.length)));
    expect(object).toBeDefined();
    const runDirectory = dirname(dirname(object!));
    await writeFile(join(runDirectory, 'artifacts.lock'), 'dead writer\n');

    await expect(store.write(scope, writeRequest('two'))).resolves.toEqual(
      expect.objectContaining({ byteLength: 3 }),
    );
  });

  it('never changes an admitted revision and ignores a torn temporary record', async () => {
    const directory = await root();
    const store = createLocalArtifactStore({ root: directory });
    const first = await store.write(scope, writeRequest('one'));
    const firstRecord = await fileContaining(directory, first.digest);
    expect(firstRecord).toBeDefined();
    const original = await readFile(firstRecord!);
    await writeFile(join(dirname(firstRecord!), '.tmp-torn'), '{');

    const second = await store.write(scope, writeRequest('two'));

    expect(await readFile(firstRecord!)).toEqual(original);
    expect(decoder.decode(await store.read(scope, first))).toBe('one');
    expect(decoder.decode(await store.read(scope, second))).toBe('two');
  });

  it('makes admission records owner-read-only and detects a valid JSON rewrite', async () => {
    const directory = await root();
    const store = createLocalArtifactStore({ root: directory });
    const reference = await store.write(scope, writeRequest('one', { purpose: 'issued' }));
    const recordPath = await fileContaining(directory, reference.digest);
    expect(recordPath).toBeDefined();
    expect((await stat(recordPath!)).mode & 0o777).toBe(0o400);

    const record = JSON.parse(await readFile(recordPath!, 'utf8')) as {
      checksum?: string;
      reference: { purpose: string };
    };
    expect(record.checksum).toMatch(/^sha256:[0-9a-f]{64}$/u);
    await chmod(recordPath!, 0o600);
    record.reference.purpose = 'forged';
    await writeFile(recordPath!, JSON.stringify(record));
    await chmod(recordPath!, 0o400);

    await expectCode(store.read(scope, {
      ...reference,
      purpose: 'forged',
    }), 'ARTIFACT_INTEGRITY');
  });

  it('makes committed blobs owner-read-only and rejects a direct overwrite', async () => {
    const directory = await root();
    const store = createLocalArtifactStore({ root: directory });
    const reference = await store.write(scope, writeRequest('hello'));
    const object = (await files(directory)).find((path) =>
      path.endsWith(reference.digest.slice('sha256:'.length)));
    expect(object).toBeDefined();

    expect((await stat(object!)).mode & 0o777).toBe(0o400);
    await expect(writeFile(object!, 'jello')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(store.read(scope, reference)).resolves.toEqual(
      new TextEncoder().encode('hello'),
    );
  });

  it('rejects an oversized admission before trusting its file length', async () => {
    const directory = await root();
    const store = createLocalArtifactStore({ root: directory });
    const reference = await store.write(scope, writeRequest('one'));
    const recordPath = await fileContaining(directory, reference.digest);
    expect(recordPath).toBeDefined();
    await chmod(recordPath!, 0o600);
    await truncate(recordPath!, OVERSIZED_FILE_BYTES);
    await chmod(recordPath!, 0o400);

    const error = await expectCode(
      store.read(scope, reference),
      'ARTIFACT_INTEGRITY',
    );
    expect(error.details).toEqual(expect.objectContaining({
      actualByteLength: OVERSIZED_FILE_BYTES,
      maxByteLength: expect.any(Number),
    }));
  });

  it('rejects an oversized blob before trusting its file length', async () => {
    const directory = await root();
    const store = createLocalArtifactStore({ root: directory });
    const reference = await store.write(scope, writeRequest('hello'));
    const object = (await files(directory)).find((path) =>
      path.endsWith(reference.digest.slice('sha256:'.length)));
    expect(object).toBeDefined();
    await chmod(object!, 0o600);
    await truncate(object!, OVERSIZED_FILE_BYTES);
    await chmod(object!, 0o400);

    const error = await expectCode(
      store.read(scope, reference),
      'ARTIFACT_INTEGRITY',
    );
    expect(error.details).toEqual(expect.objectContaining({
      actualByteLength: OVERSIZED_FILE_BYTES,
      expectedByteLength: reference.byteLength,
    }));
  });

  it('leaves a quota-rejected blob unreadable because admission happens last', async () => {
    const directory = await root();
    const store = createLocalArtifactStore({
      root: directory,
      maxArtifactBytes: 3,
      maxTotalArtifactBytesPerRun: 3,
    });
    await store.write(scope, writeRequest('one'));
    const rejectedBytes = new TextEncoder().encode('two');
    const forged: ArtifactReference = {
      schemaVersion: 1,
      digest: `sha256:${createHash('sha256').update(rejectedBytes).digest('hex')}`,
      byteLength: rejectedBytes.byteLength,
      mediaType: 'text/plain',
      purpose: 'node-output',
    };

    await expectCode(store.write(scope, writeRequest('two')), 'STORAGE_LIMIT_EXCEEDED');
    expect((await files(directory)).some((path) =>
      path.endsWith(forged.digest.slice('sha256:'.length)))).toBe(true);
    await expectCode(store.read(scope, forged), 'ARTIFACT_NOT_ADMITTED');
  });

  it('does not let a reopened provider replace a run quota', async () => {
    const directory = await root();
    const original = createLocalArtifactStore({
      root: directory,
      maxArtifactBytes: 3,
      maxTotalArtifactBytesPerRun: 3,
    });
    await original.write(scope, writeRequest('one'));
    const changed = createLocalArtifactStore({
      root: directory,
      maxArtifactBytes: 6,
      maxTotalArtifactBytesPerRun: 6,
    });

    await expectCode(
      changed.write(scope, writeRequest('two')),
      'INVALID_STORED_VALUE',
    );
  });

  it('rotates live secrets without bricking already admitted content', async () => {
    const directory = await root();
    const original = createLocalArtifactStore({
      root: directory,
      knownSecrets: ['first-secret'],
    });
    const reference = await original.write(scope, writeRequest('second-secret'));
    const firstSecretHash = createHash('sha256').update('first-secret').digest('hex');
    expect((await rawBytes(directory)).includes(Buffer.from(firstSecretHash))).toBe(false);
    const rotated = createLocalArtifactStore({
      root: directory,
      knownSecrets: ['second-secret'],
    });

    await expect(rotated.read(scope, reference)).resolves.toEqual(
      new TextEncoder().encode('second-secret'),
    );
    await expectCode(rotated.write(scope, writeRequest('second-secret')), 'KNOWN_SECRET');
    await expect(rotated.write(scope, writeRequest('first-secret'))).resolves.toBeDefined();
  });

  it('fails closed when admitted bytes are deleted or changed', async () => {
    const directory = await root();
    const store = createLocalArtifactStore({ root: directory });
    const reference = await store.write(scope, writeRequest('hello'));
    const object = (await files(directory)).find((path) =>
      path.includes(reference.digest.slice('sha256:'.length)));
    expect(object).toBeDefined();

    await chmod(object!, 0o600);
    await writeFile(object!, 'jello');
    await chmod(object!, 0o400);
    await expectCode(store.read(scope, reference), 'ARTIFACT_INTEGRITY');

    await unlink(object!);
    await expectCode(store.read(scope, reference), 'ARTIFACT_NOT_FOUND');
  });

  it('rejects a forged reference even when its digest names admitted bytes', async () => {
    const store = createLocalArtifactStore({ root: await root() });
    const reference = await store.write(scope, writeRequest('hello'));

    await expectCode(store.read(scope, {
      ...reference,
      purpose: 'forged-purpose',
    }), 'ARTIFACT_NOT_ADMITTED');
  });

  it('retains admitted bytes until the run is deleted', async () => {
    const directory = await root();
    const store = createLocalArtifactStore({ root: directory });
    const reference = await store.write(scope, writeRequest('hello'));
    const reopened = createLocalArtifactStore({ root: directory });

    await expect(reopened.read(scope, reference)).resolves.toEqual(
      new TextEncoder().encode('hello'),
    );

    await reopened.deleteRun(scope);
    await expectCode(reopened.read(scope, reference), 'ARTIFACT_NOT_ADMITTED');
  });

  it('fails closed when a managed directory is replaced by a symlink', async () => {
    const directory = await root();
    const outside = await root();
    const store = createLocalArtifactStore({ root: directory });
    await store.write(scope, writeRequest('hello'));
    const namespaceDirectory = (await readdir(join(directory, 'namespaces')))[0];
    const namespacePath = join(directory, 'namespaces', namespaceDirectory!);

    await rm(namespacePath, { recursive: true, force: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, namespacePath, 'dir');
    expect((await lstat(namespacePath)).isSymbolicLink()).toBe(true);

    await expectCode(store.write(scope, writeRequest('blocked')), 'UNSAFE_STORAGE_PATH');
    expect(await readdir(outside)).toEqual([]);
  });
});
