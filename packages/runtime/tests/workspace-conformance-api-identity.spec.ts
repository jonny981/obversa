import { expect, it } from 'vitest';

import * as apiTesting from '@obversa/api/testing';
import {
  runWorkspaceProviderConformance,
  assertWorkspaceProviderConformance,
} from '../src/workspace/conformance.js';

it('shares workspace conformance implementations through runtime and API', () => {
  expect(runWorkspaceProviderConformance).toBe(apiTesting.runWorkspaceProviderConformance);
  expect(assertWorkspaceProviderConformance).toBe(apiTesting.assertWorkspaceProviderConformance);
});
