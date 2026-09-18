import { describe, expect, it } from 'vitest';

import {
  callbackRequestDigest as apiCallbackRequestDigest,
  createCallbackGate as apiCreateCallbackGate,
  validateCallbackRequest as apiValidateCallbackRequest,
  validateCallbackResponse as apiValidateCallbackResponse,
} from '@obversa/api';
import {
  callbackRequestDigest,
  createCallbackGate,
  validateCallbackRequest,
  validateCallbackResponse,
} from '../src/callback/gate.js';

describe('callback gate API ownership', () => {
  it('reexports the same pure functions from runtime', () => {
    expect(callbackRequestDigest).toBe(apiCallbackRequestDigest);
    expect(createCallbackGate).toBe(apiCreateCallbackGate);
    expect(validateCallbackRequest).toBe(apiValidateCallbackRequest);
    expect(validateCallbackResponse).toBe(apiValidateCallbackResponse);
  });
});
