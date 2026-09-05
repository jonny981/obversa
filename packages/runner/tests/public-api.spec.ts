import { expect, it } from 'vitest';

import * as api from '../src/index.js';

it('exports only the supervised runner surface', () => {
  expect(Object.keys(api).sort()).toEqual([
    'SupervisedRunError',
    'readSupervisedRunStatus',
    'resumeSupervisedRun',
    'startSupervisedRun',
  ]);
});
