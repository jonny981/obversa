import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { StorageError } from '../storage/error.js';
import type {
  ArtifactBatch,
  ArtifactReference,
  ArtifactScope,
  ArtifactStore,
} from './store.js';

export interface ArtifactStoreConformanceOptions {
  readonly maxArtifactBytes: number;
  readonly maxTotalArtifactBytesPerRun: number;
  readonly knownSecrets: readonly string[];
}

export type ArtifactStoreConformanceFactory = (
  options: ArtifactStoreConformanceOptions,
) => ArtifactStore | Promise<ArtifactStore>;

export interface ArtifactStoreConformanceFailure {
  readonly case: string;
  readonly message: string;
}

export interface ArtifactStoreConformanceReport {
  readonly ok: boolean;
  readonly cases: number;
  readonly failures: readonly ArtifactStoreConformanceFailure[];
}

interface ConformanceCase {
  readonly name: string;
  run(factory: ArtifactStoreConformanceFactory, scope: ConformanceScope): Promise<void>;
}

type ConformanceScope = (name: string) => ArtifactScope;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HELLO_DIGEST =
  'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const DEFAULT_OPTIONS: ArtifactStoreConformanceOptions = {
  maxArtifactBytes: 64,
  maxTotalArtifactBytesPerRun: 128,
  knownSecrets: ['known-secret-value'],
};

function artifact(text: string, purpose = 'proof') {
  return {
    bytes: encoder.encode(text),
    mediaType: 'text/plain',
    purpose,
    contentMode: 'exact' as const,
  };
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectStorageError(
  operation: Promise<unknown>,
  code: StorageError['code'],
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof StorageError && error.code === code) return;
    throw new Error(
      `Expected ${code}, received ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  throw new Error(`Expected ${code}, but the operation succeeded.`);
}

const cases: readonly ConformanceCase[] = [
  {
    name: 'content address and detached read',
    async run(factory, scope) {
      const store = await factory(DEFAULT_OPTIONS);
      const location = scope('content');
      await expectStorageError(
        store.preflightWrite(location, [] as unknown as ArtifactBatch),
        'INVALID_STORED_VALUE',
      );
      const [predicted] = await store.preflightWrite(location, [artifact('hello')]);
      check(predicted !== undefined, 'Preflight did not predict a reference.');
      await expectStorageError(store.read(location, predicted), 'ARTIFACT_NOT_ADMITTED');
      const reference = await store.write(location, artifact('hello'));
      check(isDeepStrictEqual(reference, predicted), 'Write did not issue its predicted reference.');
      check(isDeepStrictEqual(reference, {
        schemaVersion: 1,
        digest: HELLO_DIGEST,
        byteLength: 5,
        mediaType: 'text/plain',
        purpose: 'proof',
      }), `Reference was ${JSON.stringify(reference)}.`);
      const first = await store.read(location, reference);
      first[0] = 0;
      const second = await store.read(location, reference);
      check(decoder.decode(second) === 'hello', 'A caller changed stored bytes through a read result.');
    },
  },
  {
    name: 'fresh-provider durable read',
    async run(factory, scope) {
      const location = scope('durable');
      const writer = await factory(DEFAULT_OPTIONS);
      const reference = await writer.write(location, artifact('durable'));
      const reader = await factory(DEFAULT_OPTIONS);
      const saved = await reader.read(location, reference);
      check(decoder.decode(saved) === 'durable', 'A fresh provider could not read admitted bytes.');
    },
  },
  {
    name: 'restart policy identity',
    async run(factory, scope) {
      const location = scope('policy');
      const writer = await factory(DEFAULT_OPTIONS);
      const reference = await writer.write(location, artifact('durable'));

      const rotatedSecrets = await factory({
        ...DEFAULT_OPTIONS,
        knownSecrets: ['replacement-secret-value'],
      });
      check(
        decoder.decode(await rotatedSecrets.read(location, reference)) === 'durable',
        'Changing live secret screening made admitted bytes unreadable.',
      );

      const changedLimits = await factory({
        ...DEFAULT_OPTIONS,
        maxArtifactBytes: DEFAULT_OPTIONS.maxArtifactBytes + 1,
      });
      await expectStorageError(
        changedLimits.read(location, reference),
        'INVALID_STORED_VALUE',
      );
    },
  },
  {
    name: 'forged exact receipt rejection',
    async run(factory, scope) {
      const store = await factory(DEFAULT_OPTIONS);
      const location = scope('forged-receipt');
      const reference = await store.write(location, artifact('private'));
      await expectStorageError(store.read(location, {
        ...reference,
        purpose: 'forged-purpose',
      }), 'ARTIFACT_NOT_ADMITTED');
    },
  },
  {
    name: 'two-provider final-capacity race',
    async run(factory, scope) {
      const options = {
        ...DEFAULT_OPTIONS,
        maxArtifactBytes: 5,
        maxTotalArtifactBytesPerRun: 5,
      };
      const first = await factory(options);
      const second = await factory(options);
      const location = scope('final-capacity-race');
      const results = await Promise.allSettled([
        first.write(location, artifact('aaa')),
        second.write(location, artifact('bbb')),
      ]);
      check(
        results.filter((result) => result.status === 'fulfilled').length === 1,
        'Two providers did not admit exactly one final-capacity artifact.',
      );
      const rejected = results.find((result) => result.status === 'rejected');
      check(
        rejected?.status === 'rejected'
          && rejected.reason instanceof StorageError
          && rejected.reason.code === 'STORAGE_LIMIT_EXCEEDED',
        'The losing provider did not report the run storage limit.',
      );
    },
  },
  {
    name: 'one-byte address change',
    async run(factory, scope) {
      const store = await factory(DEFAULT_OPTIONS);
      const location = scope('address');
      const first = await store.write(location, artifact('hello'));
      const second = await store.write(location, artifact('hellp'));
      check(first.digest !== second.digest, 'Different bytes returned the same digest.');
    },
  },
  {
    name: 'namespace isolation',
    async run(factory, scope) {
      const store = await factory(DEFAULT_OPTIONS);
      const reference = await store.write(scope('namespace-a'), artifact('private'));
      await expectStorageError(
        store.read(scope('namespace-b'), reference),
        'ARTIFACT_NOT_ADMITTED',
      );
    },
  },
  {
    name: 'run isolation',
    async run(factory, scope) {
      const store = await factory(DEFAULT_OPTIONS);
      const location = scope('run');
      const reference = await store.write(location, artifact('private'));
      await expectStorageError(
        store.read({ ...location, runId: 'run-two' }, reference),
        'ARTIFACT_NOT_ADMITTED',
      );
    },
  },
  {
    name: 'marked sensitive rejection',
    async run(factory, scope) {
      const store = await factory(DEFAULT_OPTIONS);
      await expectStorageError(
        store.write(scope('sensitive'), { ...artifact('private'), sensitive: true }),
        'SENSITIVE_CONTENT',
      );
    },
  },
  {
    name: 'known secret rejection',
    async run(factory, scope) {
      const store = await factory(DEFAULT_OPTIONS);
      await expectStorageError(
        store.write(scope('secret'), artifact('token=known-secret-value')),
        'KNOWN_SECRET',
      );
    },
  },
  {
    name: 'semantic secret rejection',
    async run(factory, scope) {
      const metadataSecret = 'quote"token';
      const stateSecret = 'line\nbreak';
      const store = await factory({
        ...DEFAULT_OPTIONS,
        knownSecrets: [metadataSecret, stateSecret],
      });
      const metadataArtifact = artifact('safe', metadataSecret);
      await expectStorageError(
        store.preflightWrite(scope('secret-metadata'), [metadataArtifact]),
        'KNOWN_SECRET',
      );
      await expectStorageError(
        store.write(scope('secret-metadata'), metadataArtifact),
        'KNOWN_SECRET',
      );

      const stateArtifact = {
        bytes: encoder.encode(JSON.stringify({ token: stateSecret })),
        mediaType: 'application/problem+json',
        purpose: 'state',
        contentMode: 'state' as const,
      };
      await expectStorageError(
        store.preflightWrite(scope('secret-state'), [stateArtifact]),
        'KNOWN_SECRET',
      );
      await expectStorageError(
        store.write(scope('secret-state'), stateArtifact),
        'KNOWN_SECRET',
      );
    },
  },
  {
    name: 'free-text redaction before receipt',
    async run(factory, scope) {
      const store = await factory(DEFAULT_OPTIONS);
      const location = scope('redaction');
      const reference = await store.write(location, {
        ...artifact('token=known-secret-value'),
        contentMode: 'free-text',
      });
      const saved = await store.read(location, reference);
      check(decoder.decode(saved) === 'token=[redacted]', 'Known secret was not redacted.');
      check(reference.byteLength === 16, 'Receipt size was not calculated after redaction.');
    },
  },
  {
    name: 'single-artifact limit',
    async run(factory, scope) {
      const store = await factory({
        ...DEFAULT_OPTIONS,
        maxArtifactBytes: 5,
        maxTotalArtifactBytesPerRun: 8,
      });
      await expectStorageError(
        store.write(scope('item-limit'), artifact('123456')),
        'STORAGE_LIMIT_EXCEEDED',
      );
    },
  },
  {
    name: 'unique-digest run quota',
    async run(factory, scope) {
      const store = await factory({
        ...DEFAULT_OPTIONS,
        maxArtifactBytes: 5,
        maxTotalArtifactBytesPerRun: 5,
      });
      const location = scope('run-limit');
      await expectStorageError(store.preflightWrite(location, [
        artifact('aaa'),
        artifact('bbb'),
      ]), 'STORAGE_LIMIT_EXCEEDED');
      const first = await store.write(location, artifact('12345'));
      const duplicate = await store.write(location, artifact('12345', 'second-use'));
      check(first.digest === duplicate.digest, 'Duplicate content changed its digest.');
      await expectStorageError(
        store.write(location, artifact('x')),
        'STORAGE_LIMIT_EXCEEDED',
      );
    },
  },
  {
    name: 'run deletion',
    async run(factory, scope) {
      const store = await factory(DEFAULT_OPTIONS);
      const location = scope('delete');
      const reference = await store.write(location, artifact('hello'));
      await store.deleteRun(location);
      await expectStorageError(store.read(location, reference), 'ARTIFACT_NOT_ADMITTED');
    },
  },
];

/** Run the framework-free behavioral checks for an ArtifactStore provider. */
export async function runArtifactStoreConformance(
  factory: ArtifactStoreConformanceFactory,
): Promise<ArtifactStoreConformanceReport> {
  const invocation = randomUUID();
  const scope: ConformanceScope = (name) => ({
    namespace: `conformance-${invocation}-${name}`,
    runId: 'run-one',
  });
  const failures: ArtifactStoreConformanceFailure[] = [];
  for (const testCase of cases) {
    try {
      await testCase.run(factory, scope);
    } catch (error) {
      failures.push({
        case: testCase.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return Object.freeze({
    ok: failures.length === 0,
    cases: cases.length,
    failures: Object.freeze(failures.map((failure) => Object.freeze(failure))),
  });
}

/** Throw one readable error when an ArtifactStore provider breaks the contract. */
export async function assertArtifactStoreConformance(
  factory: ArtifactStoreConformanceFactory,
): Promise<void> {
  const report = await runArtifactStoreConformance(factory);
  if (report.ok) return;
  const detail = report.failures
    .map((failure) => `${failure.case}: ${failure.message}`)
    .join('; ');
  throw new Error(`Artifact store conformance failed: ${detail}`);
}
