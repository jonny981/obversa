import { describe, expect, it } from 'vitest';

import * as publicApi from '../src/index.ts';
import {
  openGitMemory,
  openReasoningRecord,
  type GitMemoryOptions,
  type ReasoningRecordOptions,
} from '../src/index.ts';

/**
 * What this package offers, named once. Two things over one repository with
 * different semantics: Git as a store, and Git as the record of why a change
 * was made. A name added without a line here is a name nobody decided to ship.
 */
describe('@obversa/memory-git', () => {
  it('exports the store and the record, and nothing else', () => {
    expect(Object.keys(publicApi).sort()).toEqual(['openGitMemory', 'openReasoningRecord']);
    expect(typeof openGitMemory).toBe('function');
    expect(typeof openReasoningRecord).toBe('function');
  });

  it('names the options each one takes', () => {
    const store: GitMemoryOptions = { repositoryPath: '/tmp/fixture', scope: 'fixture' };
    const record: ReasoningRecordOptions = { repositoryPath: '/tmp/fixture', stage: 'implement' };

    expect(store.scope).toBe('fixture');
    // The record is opted into by a stage, so the stage is what it is given
    // and what its refusal names.
    expect(record.stage).toBe('implement');
  });
});
