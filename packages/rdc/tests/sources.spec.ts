import { describe, expect, it } from 'vitest';

import {
  pickFromSources,
  SourceReadError,
  type CandidateReadResult,
  type CandidateSource,
  type MemoryCandidate,
  type PickAnswer,
} from '../src/index.js';

function candidate(overrides: Partial<MemoryCandidate> & Pick<MemoryCandidate, 'sourceId' | 'id'>): MemoryCandidate {
  return {
    role: 'reference',
    title: overrides.id,
    text: `text of ${overrides.sourceId}/${overrides.id}`,
    signals: { score: 1 },
    ...overrides,
  };
}

function source(
  id: string,
  role: CandidateSource['role'],
  read: () => Promise<CandidateReadResult>,
): CandidateSource {
  return { id, role, read };
}

const sayYes = async (batch: { questions: readonly { key: string }[] }) =>
  Object.fromEntries(batch.questions.map((question) => [
    question.key,
    { status: 'answered' as const, probability: 0.9 } satisfies PickAnswer,
  ]));

describe('pickFromSources', () => {
  it('reads every source and picks over the combined candidates', async () => {
    const result = await pickFromSources(
      [
        source('notes', 'reference', async () => ({
          status: 'read',
          complete: true,
          candidates: [candidate({ sourceId: 'notes', id: 'n1' })],
        })),
        source('policy', 'rule', async () => ({
          status: 'read',
          complete: true,
          candidates: [candidate({ sourceId: 'policy', id: 'r1', role: 'rule' })],
        })),
      ],
      { task: 'the task' },
      { task: 'the task', decide: sayYes },
    );

    expect(result.selected.map((item) => item.id).sort()).toEqual(['n1', 'r1']);
    expect(result.record.rulesCoverage).toBe('complete');
    expect(result.reads.map((read) => read.status)).toEqual(['read', 'read']);
  });

  it('treats an absent source as a result, not a failure', async () => {
    const result = await pickFromSources(
      [
        source('gone', 'reference', async () => ({ status: 'absent', reason: 'no directory' })),
        source('notes', 'reference', async () => ({
          status: 'read',
          complete: true,
          candidates: [candidate({ sourceId: 'notes', id: 'n1' })],
        })),
      ],
      { task: 'the task' },
      { task: 'the task', decide: sayYes },
    );

    expect(result.reads[0]).toEqual({ status: 'absent', reason: 'no directory' });
    expect(result.selected.map((item) => item.id)).toEqual(['n1']);
  });

  it('copies the read revision onto candidates that do not carry one', async () => {
    const result = await pickFromSources(
      [
        source('history', 'reference', async () => ({
          status: 'read',
          revision: 'abc123',
          complete: true,
          candidates: [
            candidate({ sourceId: 'history', id: 'a' }),
            candidate({ sourceId: 'history', id: 'b', sourceRevision: 'pinned-self' }),
          ],
        })),
      ],
      { task: 'the task' },
      { task: 'the task', decide: sayYes },
    );

    const byId = new Map(result.selected.map((item) => [item.id, item]));
    expect(byId.get('a')?.sourceRevision).toBe('abc123');
    expect(byId.get('b')?.sourceRevision).toBe('pinned-self');
  });

  it('reports incomplete coverage when a rule source read was truncated, even with every rule answered', async () => {
    const result = await pickFromSources(
      [
        source('policy', 'rule', async () => ({
          status: 'read',
          complete: false,
          partial: 'the limit kept 1 of 3 candidates',
          candidates: [candidate({ sourceId: 'policy', id: 'r1', role: 'rule' })],
        })),
      ],
      { task: 'the task' },
      { task: 'the task', decide: sayYes },
    );

    expect(result.record.rulesCoverage).toBe('incomplete');
    expect(result.selected.map((item) => item.id)).toEqual(['r1']);
  });

  it('keeps a caller-supplied rulesEnumerationComplete: false when every source read completely', async () => {
    const result = await pickFromSources(
      [
        source('policy', 'rule', async () => ({
          status: 'read',
          complete: true,
          candidates: [candidate({ sourceId: 'policy', id: 'r1', role: 'rule' })],
        })),
      ],
      { task: 'the task' },
      { task: 'the task', decide: sayYes, rulesEnumerationComplete: false },
    );

    // The caller warned that rules were omitted upstream; a clean set of
    // source reads must not turn that warning back into 'complete'.
    expect(result.record.rulesCoverage).toBe('incomplete');
  });

  it('reports incomplete coverage when a rule source is absent', async () => {
    const result = await pickFromSources(
      [
        source('policy', 'rule', async () => ({ status: 'absent', reason: 'no rules directory' })),
        source('notes', 'reference', async () => ({
          status: 'read',
          complete: true,
          candidates: [candidate({ sourceId: 'notes', id: 'n1' })],
        })),
      ],
      { task: 'the task' },
      { task: 'the task', decide: sayYes },
    );

    expect(result.record.rulesCoverage).toBe('incomplete');
    expect(result.selected.map((item) => item.id)).toEqual(['n1']);
  });

  it('lets an absent reference source leave rule coverage complete', async () => {
    const result = await pickFromSources(
      [
        source('gone', 'reference', async () => ({ status: 'absent', reason: 'no directory' })),
        source('policy', 'rule', async () => ({
          status: 'read',
          complete: true,
          candidates: [candidate({ sourceId: 'policy', id: 'r1', role: 'rule' })],
        })),
      ],
      { task: 'the task' },
      { task: 'the task', decide: sayYes },
    );

    expect(result.record.rulesCoverage).toBe('complete');
  });

  it('propagates a source read failure', async () => {
    await expect(
      pickFromSources(
        [source('broken', 'reference', async () => {
          throw new SourceReadError('failed', 'permission denied');
        })],
        { task: 'the task' },
        { task: 'the task', decide: sayYes },
      ),
    ).rejects.toMatchObject({ name: 'SourceReadError', code: 'failed' });
  });
});
