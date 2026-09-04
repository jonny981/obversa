import { isDeepStrictEqual } from 'node:util';

import type {
  ArtifactReference,
  ArtifactScope,
  ArtifactStore,
  NewArtifact,
} from '../artifacts/store.js';
import { canonicalJson, digestJson, type JsonObject } from '../graph/value.js';
import { StorageError } from '../storage/error.js';

export type ProofArtifactReference = ArtifactReference<'proof-packet'>;

/** Write one stable proof packet and refuse a store that reports another identity. */
export async function writeProofArtifact(
  store: ArtifactStore,
  scope: ArtifactScope,
  packet: JsonObject,
): Promise<ProofArtifactReference> {
  const bytes = new TextEncoder().encode(canonicalJson(packet));
  const artifact: NewArtifact = {
    bytes,
    mediaType: 'application/json',
    purpose: 'proof-packet',
    contentMode: 'state',
  };
  const expected: ProofArtifactReference = {
    schemaVersion: 1,
    digest: digestJson(packet),
    byteLength: bytes.byteLength,
    mediaType: artifact.mediaType,
    purpose: 'proof-packet',
  };
  const predicted = await store.preflightWrite(scope, [artifact]);
  if (predicted.length !== 1 || !isDeepStrictEqual(predicted[0], expected)) {
    throw new StorageError(
      'ARTIFACT_INTEGRITY',
      'Artifact store predicted the wrong proof reference.',
      { expected, actual: predicted[0] ?? null },
    );
  }
  const written = await store.write(scope, artifact);
  if (!isDeepStrictEqual(written, expected)) {
    throw new StorageError(
      'ARTIFACT_INTEGRITY',
      'Artifact store returned the wrong proof reference.',
      { expected, actual: written },
    );
  }
  return written as ProofArtifactReference;
}
