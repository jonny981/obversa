import { describe, expect, it, vi } from 'vitest';

import { openReasoningRecord, type CapturedTurn } from '../src/index.ts';

const token = `sk-${'a'.repeat(32)}`;

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

  it('scrubs recognised tokens from the finished subject and body', async () => {
    const record = openReasoningRecord({
      stage: 'implement',
      compose: () => ({
        subject: `feat(implement): retry requests using ${token}`,
        body: `## Why\n\nUsing ${token} keeps retries within the request budget.`,
      }),
    });

    const message = await record.message({ status: 'pass' });

    expect(message).toEqual({
      subject: 'feat(implement): retry requests using [redacted]',
      body: '## Why\n\nUsing [redacted] keeps retries within the request budget.',
    });
  });

  it('keeps split text and thinking unchanged for composition, then scrubs the joined message', async () => {
    const seen: CapturedTurn[] = [];
    const first = 'Chose retries for sk-aaaa';
    const second = `${'a'.repeat(28)} because calls fail in bursts.`;
    const record = openReasoningRecord({
      stage: 'implement',
      compose: ({ captured }) => {
        seen.push(...captured);
        return {
          subject: 'feat(implement): retry burst failures',
          body: `## Why\n\n${captured.map((entry) => entry.text).join('')}`,
        };
      },
    });

    record.observe(turn(first));
    record.observe({ kind: 'engine:thinking', path: ['delivery', 'implement'], delta: second });
    const message = await record.message({ status: 'pass' });

    expect(seen).toEqual([
      { node: 'implement', text: first },
      { node: 'implement', text: second },
    ]);
    expect(message.body).toBe('## Why\n\nChose retries for [redacted] because calls fail in bursts.');
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

  it('binds to the path of the first event carrying its stage name', async () => {
    // Two holes, closed in turn. An empty filter accepted everything, so a
    // record opened with a stage and no path took a sibling's reasoning.
    // Matching the last segment closed that but left this one: two stages both
    // named implement, under different parents, both end in implement, so one
    // record still took both. This assertion used to expect 'mine too' and
    // that expectation WAS the hole. The first matching event now fixes the
    // path and a same-named stage elsewhere in the run cannot join it.
    const seen: string[] = [];
    const record = openReasoningRecord({
      stage: 'implement',
      compose: ({ captured }) => {
        seen.push(...captured.map((entry) => entry.text));
        return { subject: 'feat(implement): x', body: 'why' };
      },
    });

    record.observe(turn('mine', ['delivery', 'implement']));
    record.observe(turn('the sibling\'s', ['delivery', 'document']));
    record.observe(turn('another implement stage', ['other-run', 'implement']));
    // The pin must not shut the record to its own stage's later turns.
    record.observe(turn('mine as well', ['delivery', 'implement']));
    await record.message({ status: 'pass' });

    expect(seen).toEqual(['mine', 'mine as well']);
  });

  it('keeps the turns of a looped or nested writer under its stage', async () => {
    // The turns of a real stage do not arrive on the stage's own path.
    // isolated() appends its label, a loop appends its name, and the engine
    // emits under that. Requiring the stage name to be the LAST segment made a
    // stage that is a loop capture nothing at all and floor to zero turns,
    // which is exactly what the package page's own example builds.
    const seen: string[] = [];
    const record = openReasoningRecord({
      stage: 'implement',
      compose: ({ captured }) => {
        seen.push(...captured.map((entry) => entry.text));
        return { subject: 'feat(implement): x', body: 'why' };
      },
    });

    record.observe(turn('first pass', ['delivery', 'implement', 'write']));
    record.observe(turn('second pass', ['delivery', 'implement', 'write']));
    record.observe(turn('deeper still', ['delivery', 'implement', 'write', 'attempt-2']));
    record.observe(turn('a sibling stage', ['delivery', 'document', 'write']));
    record.observe(turn('the same name elsewhere', ['other-run', 'implement', 'write']));
    await record.message({ status: 'pass' });

    expect(seen).toEqual(['first pass', 'second pass', 'deeper still']);
  });

  it('bounds the body it will put on a commit', async () => {
    // Writer turns are the engine's raw stream, not the scrubbed result text,
    // and a commit is permanent and pushable. An hour of streaming must not
    // become an unbounded body in history.
    const record = openReasoningRecord({
      stage: 'implement',
      compose: () => ({ subject: 'feat(implement): x', body: 'y'.repeat(40_000) }),
    });

    record.observe(turn('mine'));
    const message = await record.message({ status: 'pass' });

    expect(message.body.length).toBeLessThan(20_000);
    expect(message.body).toContain('body truncated');
  });

  it('scrubs a token across the body limit before truncating', async () => {
    // Six token characters (sk-aaa) precede the cut. Truncating first leaves
    // too few characters for the recognised pattern to match.
    const before = `${'Ordinary reasoning. '.padEnd(15_993, 'x')} `;
    const record = openReasoningRecord({
      stage: 'implement',
      compose: () => ({
        subject: 'feat(implement): retry burst failures',
        body: `${before}${token} ${'ordinary text after the token. '.repeat(10)}`,
      }),
    });

    const message = await record.message({ status: 'pass' });

    expect(message.body).not.toContain('sk-');
    expect(message.body).toBe(`${before}[redac\n\n[record: body truncated at 16000 characters]`);
  });

  it('refuses a composed subject that is not one line, and says so at the floor', async () => {
    // ReasoningMessage promises one line then the reasoning under it. A
    // subject carrying a newline breaks that silently: everything after the
    // newline reads as body with no blank line before it.
    const record = openReasoningRecord({
      stage: 'implement',
      compose: () => ({ subject: 'feat(implement): x\nand a second line', body: 'why' }),
    });

    record.observe(turn('mine'));
    const message = await record.message({ status: 'pass', summary: 'done' });

    expect(message.subject).not.toContain('\n');
    expect(message.subject).toBe('record(implement): done');
  });

  it('normalises a multiline outcome summary into the floor subject', async () => {
    // The summary comes from the job and can be many lines. The floor exists
    // to be dependable, so it must not inherit the problem it is there for.
    const record = openReasoningRecord({ stage: 'implement' });

    record.observe(turn('mine'));
    const message = await record.message({ status: 'pass', summary: 'built the thing\nover two lines' });

    expect(message.subject).not.toContain('\n');
    expect(message.subject).toBe('record(implement): built the thing over two lines');
  });

  it('starts the next iteration empty once its message is on a commit', async () => {
    const bodies: string[] = [];
    const record = openReasoningRecord({
      stage: 'implement',
      compose: ({ captured }) => {
        bodies.push(captured.map((entry) => entry.text).join(','));
        return { subject: 'feat(implement): x', body: 'why' };
      },
    });

    record.observe(turn('first'));
    await record.message({ status: 'pass' });
    record.committed('abc1234');
    record.observe(turn('second'));
    await record.message({ status: 'pass' });

    // Without the reset the second body carried the first iteration's turns.
    expect(bodies).toEqual(['first', 'second']);
  });

  it('says so when it observed nothing, rather than composing from an empty run', async () => {
    // Forgetting to feed the events is a real mistake, and a body that reads
    // as reasoning when none was captured hides it.
    const record = openReasoningRecord({ stage: 'implement', compose: () => undefined });

    const message = await record.message({ status: 'pass', summary: 'done' });

    expect(message.body).toContain('0 captured turns');
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

  it.each([
    { selection: 'no composer', compose: undefined },
    { selection: 'a thrown composer', compose: () => { throw new Error('composition failed'); } },
    { selection: 'an unusable composition', compose: () => ({ subject: '   ', body: '' }) },
  ])('scrubs the fallback summary with $selection', async ({ compose }) => {
    const record = openReasoningRecord({
      stage: 'implement',
      ...(compose === undefined ? {} : { compose }),
    });

    record.observe(turn('calls fail in bursts'));
    const message = await record.message({ status: 'pass', summary: `configured ${token} for retries` });

    expect(message).toEqual({
      subject: 'record(implement): configured [redacted] for retries',
      body: [
        '## Why',
        '',
        'Composition left no message, so this is the deterministic floor: the',
        'stage ended pass with 1 captured turn. The reasoning for this',
        'change was not composed, and the outcome above is what the record can',
        'state.',
      ].join('\n'),
    });
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
