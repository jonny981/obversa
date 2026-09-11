import { expect, expectTypeOf, it } from 'vitest';

import * as api from '../src/index.js';

it('exports only the supervised runner surface', () => {
  expect(Object.keys(api).sort()).toEqual([
    'SupervisedRunError',
    'readSupervisedRunStatus',
    'resumeSupervisedRun',
    'startSupervisedRun',
  ]);
});

interface ExtendedGraphResume extends api.ResumeSupervisedRunOptions {
  readonly note: string;
}
type AcceptedResume = Parameters<typeof api.resumeSupervisedRun>[0];
type MixedResume = api.ResumeSupervisedRunOptions & { readonly preflightEventId: string };
type MixedAccepted = MixedResume extends AcceptedResume ? true : false;

it('retains graph interface extension and accepts only one resume form', () => {
  expectTypeOf<ExtendedGraphResume['position']>().toEqualTypeOf<string>();
  expectTypeOf<api.ResumePreflightSupervisedRunOptions['preflightEventId']>().toEqualTypeOf<string>();
  expectTypeOf<MixedAccepted>().toEqualTypeOf<false>();
  expectTypeOf<api.ResumePreflightSupervisedRunOptions>().toExtend<AcceptedResume>();
});
