import { describe, expect, it } from 'vitest';

import { StorageError } from '../src/storage/error.js';
import {
  validateArtifactReference,
  validateArtifactScope,
  validateNewArtifact,
} from '../src/artifacts/store.js';

const HELLO_DIGEST =
  'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

describe('artifact storage values', () => {
  it('validates a strict, detached, frozen artifact reference', () => {
    const input = {
      schemaVersion: 1,
      digest: HELLO_DIGEST,
      byteLength: 5,
      mediaType: 'text/plain',
      purpose: 'review-proof',
    };

    const reference = validateArtifactReference(input);

    expect(reference).toEqual(input);
    expect(reference).not.toBe(input);
    expect(Object.isFrozen(reference)).toBe(true);
    input.purpose = 'changed';
    expect(reference.purpose).toBe('review-proof');
  });

  it.each([
    ['unknown fields', {
      schemaVersion: 1,
      digest: HELLO_DIGEST,
      byteLength: 5,
      mediaType: 'text/plain',
      purpose: 'proof',
      future: true,
    }],
    ['wrong schema', {
      schemaVersion: 2,
      digest: HELLO_DIGEST,
      byteLength: 5,
      mediaType: 'text/plain',
      purpose: 'proof',
    }],
    ['forged digest', {
      schemaVersion: 1,
      digest: 'sha256:not-a-digest',
      byteLength: 5,
      mediaType: 'text/plain',
      purpose: 'proof',
    }],
    ['negative size', {
      schemaVersion: 1,
      digest: HELLO_DIGEST,
      byteLength: -1,
      mediaType: 'text/plain',
      purpose: 'proof',
    }],
    ['invalid media type', {
      schemaVersion: 1,
      digest: HELLO_DIGEST,
      byteLength: 5,
      mediaType: 'plain text',
      purpose: 'proof',
    }],
    ['blank purpose', {
      schemaVersion: 1,
      digest: HELLO_DIGEST,
      byteLength: 5,
      mediaType: 'text/plain',
      purpose: ' ',
    }],
    ['oversized purpose', {
      schemaVersion: 1,
      digest: HELLO_DIGEST,
      byteLength: 5,
      mediaType: 'text/plain',
      purpose: 'p'.repeat(513),
    }],
  ])('rejects %s instead of silently changing stored data', (_label, input) => {
    expect(() => validateArtifactReference(input)).toThrowError(StorageError);
  });

  it('copies write bytes before returning the validated request', () => {
    const bytes = new TextEncoder().encode('hello');

    const request = validateNewArtifact({
      bytes,
      mediaType: 'text/plain',
      purpose: 'review-proof',
      contentMode: 'exact',
    });

    expect(request).not.toBe(bytes);
    expect(request.bytes).not.toBe(bytes);
    bytes[0] = 0;
    expect(new TextDecoder().decode(request.bytes)).toBe('hello');
  });

  it.each([
    ['empty namespace', { namespace: '', runId: 'run-one' }],
    ['traversal namespace', { namespace: '../outside', runId: 'run-one' }],
    ['empty run', { namespace: 'host-one', runId: '' }],
    ['traversal run', { namespace: 'host-one', runId: 'a/../../outside' }],
  ])('rejects an %s before filesystem access', (_label, identity) => {
    expect(() => validateArtifactScope(identity)).toThrowError(StorageError);
  });

  it.each([
    ['namespace', () => validateArtifactScope({ namespace: 'host-\ud800', runId: 'run-one' })],
    ['run id', () => validateArtifactScope({ namespace: 'host-one', runId: 'run-\ud801' })],
    ['new-artifact purpose', () => validateNewArtifact({
      bytes: new Uint8Array(),
      mediaType: 'text/plain',
      purpose: 'proof-\ud800',
      contentMode: 'exact',
    })],
    ['reference purpose', () => validateArtifactReference({
      schemaVersion: 1,
      digest: HELLO_DIGEST,
      byteLength: 5,
      mediaType: 'text/plain',
      purpose: 'proof-\ud801',
    })],
  ])('rejects malformed Unicode in %s', (_label, validate) => {
    expect(validate).toThrowError(expect.objectContaining({
      name: 'StorageError',
      code: 'INVALID_STORED_VALUE',
    }));
  });
});
