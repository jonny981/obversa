import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_QUESTION_TEXT,
  gitHistory,
  knowledgeBase,
  pick,
  PICK_QUESTION_VERSION,
  pickFromSources,
  rules,
  SourceReadError,
  type CandidateSource,
  type GitHistoryOptions,
  type KnowledgeBaseOptions,
  type MemoryCandidate,
  type PickThresholds,
} from '../src/index.js';

describe('@obversa/rdc', () => {
  it('exports the sources, the picker, and their option types', () => {
    const historyOptions: GitHistoryOptions = {
      id: 'history',
      repository: 'key',
      blame: true,
      coChange: true,
    };
    const history: CandidateSource = gitHistory('/nonexistent', historyOptions);
    const baseOptions: KnowledgeBaseOptions = {
      maxQuestionText: 100,
      repository: 'key',
    };
    const base: CandidateSource = knowledgeBase('/nonexistent', baseOptions);
    const ruleSource: CandidateSource = rules('/nonexistent');
    const thresholds: PickThresholds = { reference: 0.6, rule: 0.6, linkedPathBar: 0.4 };
    const candidate: MemoryCandidate = {
      sourceId: 'history',
      role: 'reference',
      id: 'commit abc1234',
      title: 'a change',
      text: 'the body',
      contentRef: 'abc1234',
      changedPaths: ['docs/a.md'],
      path: 'docs/a.md',
      repository: 'key',
      signals: { recency: 1 },
    };

    expect(history.role).toBe('reference');
    expect(base.role).toBe('reference');
    expect(ruleSource.role).toBe('rule');
    expect(thresholds.linkedPathBar).toBe(0.4);
    expect(candidate.changedPaths).toHaveLength(1);
    expect(typeof pick).toBe('function');
    expect(typeof pickFromSources).toBe('function');
    expect(new SourceReadError('failed', 'x')).toBeInstanceOf(Error);
    expect(DEFAULT_MAX_QUESTION_TEXT).toBeGreaterThan(0);
    expect(PICK_QUESTION_VERSION).toContain('memory-pick');
  });
});
