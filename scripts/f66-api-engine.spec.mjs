import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EngineError, classifyEngineFailure, digestJson } from '@obversa/api';

test('the API keeps one engine error identity and shared JSON digest', () => {
  const error = new EngineError({ kind: 'auth', message: 'invalid key' });
  assert.equal(classifyEngineFailure(error), 'auth');
  assert.equal(digestJson({ second: 2, first: 1 }), digestJson({ first: 1, second: 2 }));
});
