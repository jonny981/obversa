import { describe, expect, it, vi } from 'vitest';

import { openReasoningRecord } from '../src/index.ts';

const turn = (delta: string, path: readonly string[] = ['delivery', 'implement']) => ({
  kind: 'engine:text' as const,
  path,
  delta,
});

describe('the reasoning record', () => {
  it('composes a message from the stage\'s own turns', async () => {
    const record = openReasoningRecord({
      stage: 'implement',
      path: ['delivery', 'implement'],
      compose: ({ captured, stage }) => ({
        subject: `feat(${stage}): the change`,
        body: `## Why\n\n${captured.map((entry) => entry.text).join(' ')}`,
      }),
    });

    record.observe(turn('the first attempt used a clock, '));
    record.observe(turn('which fails under load'));
    const message = await record.message({ status: 'pass', summary: 'done' });

    expect(message.subject).toBe('feat(implement): the change');
    expect(message.body).toContain('fails under load');
  });

  it('keeps a sibling stage out of this stage\'s body', async () => {
    // A run writes several stages at once. A body that carried a sibling's
    // words would explain this change with another change's reasoning.
    const seen: string[] = [];
    const record = openReasoningRecord({
      stage: 'implement',
      path: ['delivery', 'implement'],
      compose: ({ captured }) => {
        seen.push(...captured.map((entry) => entry.text));
        return { subject: 'feat(implement): x', body: 'why' };
      },
    });

    record.observe(turn('mine'));
    record.observe(turn('the sibling\'s', ['delivery', 'document']));
    record.observe(turn('mine too'));
    await record.message({ status: 'pass' });

    expect(seen).toEqual(['mine', 'mine too']);
  });

  it('keeps a writer\'s words and ignores the run\'s other traffic', async () => {
    const seen: string[] = [];
    const record = openReasoningRecord({
      stage: 'implement',
      compose: ({ captured }) => {
        seen.push(...captured.map((entry) => entry.text));
        return { subject: 'feat(implement): x', body: 'why' };
      },
    });

    record.observe(turn('kept'));
    record.observe({ kind: 'engine:thinking', path: ['delivery', 'implement'], delta: 'also kept' });
    record.observe({ kind: 'engine:tool', path: ['delivery', 'implement'] });
    record.observe({ kind: 'dag:node', path: ['delivery'] });
    await record.message({ status: 'pass' });

    expect(seen).toEqual(['kept', 'also kept']);
  });

  it('takes the floor when composition throws, naming the stage and its outcome', async () => {
    const record = openReasoningRecord({
      stage: 'implement',
      compose: () => { throw new Error('the composer was unreachable'); },
    });

    record.observe(turn('reasoning that will not be composed'));
    const message = await record.message({ status: 'pass', summary: 'the stage finished anyway' });

    expect(message.subject).toContain('implement');
    expect(message.subject).toContain('the stage finished anyway');
    expect(message.body).toContain('deterministic floor');
  });

  it('takes the floor when composition returns something unusable', async () => {
    const record = openReasoningRecord({
      stage: 'implement',
      compose: () => ({ subject: '   ', body: '' }),
    });

    const message = await record.message({ status: 'fail' });

    expect(message.subject).toContain('implement');
    expect(message.body).toContain('deterministic floor');
  });

  it('keeps the captured turns when a caller asks twice', async () => {
    // The commit this message is written on can fail. Composing from nothing
    // on the retry would write the floor over reasoning still held.
    const compose = vi.fn(({ captured }) => ({
      subject: 'feat(implement): x',
      body: `${captured.length} turns`,
    }));
    const record = openReasoningRecord({ stage: 'implement', compose });

    record.observe(turn('one'));
    record.observe(turn('two'));
    const first = await record.message({ status: 'pass' });
    const second = await record.message({ status: 'pass' });

    expect(first.body).toBe('2 turns');
    expect(second.body).toBe('2 turns');
    expect(compose).toHaveBeenCalledTimes(2);
  });
});
