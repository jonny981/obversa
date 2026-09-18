import { describe, expect, it } from 'vitest';

import * as api from '@obversa/api';
import * as apiTesting from '@obversa/api/testing';
import * as artifacts from '../src/artifacts/store.js';
import * as artifactConformance from '../src/artifacts/conformance.js';
import * as events from '../src/events/envelope.js';
import * as eventStore from '../src/events/store.js';
import * as eventConformance from '../src/events/conformance.js';
import { StorageError } from '../src/storage/error.js';
import { validateStorageId } from '../src/storage/id.js';

describe('storage contracts shared with API', () => {
  it('retains one validator and error constructor across runtime imports', () => {
    expect(StorageError).toBe(api.StorageError);
    expect(validateStorageId).toBe(api.validateStorageId);
    for (const [name, value] of Object.entries({ ...artifacts, ...events, ...eventStore })) {
      expect(value, name).toBe(api[name as keyof typeof api]);
    }
    expect(() => artifacts.validateArtifactScope({ namespace: '../outside', runId: 'run' }))
      .toThrow(api.StorageError);
    expect(() => events.validateNewDomainEvent({}))
      .toThrow(api.StorageError);
  });

  it('retains one set of provider conformance checks', () => {
    for (const [name, value] of Object.entries({ ...artifactConformance, ...eventConformance })) {
      expect(value, name).toBe(apiTesting[name as keyof typeof apiTesting]);
    }
  });
});
