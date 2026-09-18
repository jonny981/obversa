import { expect, it } from 'vitest';

import * as api from '@obversa/api';
import {
  acceptedResultMatches,
  validateAcceptedResultRecord,
} from '../src/proof/acceptance.js';

it('uses the same accepted-result validators through runtime and API', () => {
  expect(acceptedResultMatches).toBe(api.acceptedResultMatches);
  expect(validateAcceptedResultRecord).toBe(api.validateAcceptedResultRecord);
  expect(() => validateAcceptedResultRecord({})).toThrow('invalid accepted-result record');
});
