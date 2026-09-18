import { describe, expect, it } from 'vitest';

import * as api from '@obversa/api';
import {
  validateRunDefinition,
  validateRunStartRecord,
  validateRunStoragePolicy,
  validateRunStorageRecord,
} from '../src/runtime/run-definition.js';

describe('run definition contracts shared with API', () => {
  it('retains the API validator and error identities through runtime imports', () => {
    for (const [name, validate] of Object.entries({
      validateRunDefinition,
      validateRunStartRecord,
      validateRunStoragePolicy,
      validateRunStorageRecord,
    })) {
      expect(validate, name).toBe(api[name as keyof typeof api]);
      expect(() => validate({})).toThrow(api.StorageError);
    }
  });
});
