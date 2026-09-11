import { describe, expect, it } from 'vitest';

import type {
  AgentResult,
  EngineSelectionRecord,
  UsageReceipt,
} from '../src/index.ts';
import {
  engineSelection,
  finalResultPart,
  finalResultText,
  validateAgentResult,
  validateIncompleteResultEvidence,
} from '../src/result.ts';

const selection: EngineSelectionRecord = {
  adapter: 'scripted',
  adapterVersion: '1.0.0',
  provider: null,
  modelFamily: null,
  model: 'fixture-model',
  executable: null,
  capabilities: ['read'],
};

function result(
  parts: AgentResult['parts'],
  usage: UsageReceipt = { kind: 'unknown' },
): AgentResult {
  return {
    parts,
    usage,
    requested: selection,
    effective: selection,
  };
}

describe('engine result records', () => {
  it('records an absolute selected executable and rejects a relative path', () => {
    expect(engineSelection({
      adapter: 'scripted',
      executable: '/opt/obversa/bin/engine-wrapper',
    }).executable).toBe('/opt/obversa/bin/engine-wrapper');
    expect(engineSelection({ adapter: 'api' }).executable).toBeNull();
    expect(() => engineSelection({
      adapter: 'scripted',
      executable: 'engine-wrapper',
    })).toThrow('selection.executable must be an absolute path or null');
  });

  it('preserves ordered assistant continuations and one marked final part', () => {
    const validated = validateAgentResult(result([
      { kind: 'assistant', text: 'first', final: false },
      { kind: 'assistant', text: 'second', final: true },
    ]));

    expect(validated.parts).toEqual([
      { kind: 'assistant', text: 'first', final: false },
      { kind: 'assistant', text: 'second', final: true },
    ]);
    expect(finalResultPart(validated)).toEqual(validated.parts[1]);
    expect(finalResultText(validated)).toBe('second');
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.parts)).toBe(true);
  });

  it('keeps missing usage unknown and a reported zero receipt reported', () => {
    expect(validateAgentResult(result([
      { kind: 'assistant', text: 'done', final: true },
    ])).usage).toEqual({ kind: 'unknown' });

    expect(validateAgentResult(result(
      [{ kind: 'assistant', text: 'done', final: true }],
      { kind: 'reported', inputTokens: 0, outputTokens: 0 },
    )).usage).toEqual({
      kind: 'reported',
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('accepts a structured final value without inventing final text', () => {
    const validated = validateAgentResult(result([
      { kind: 'structured', value: { answer: 42 }, final: true },
    ]));

    expect(finalResultPart(validated)).toEqual({
      kind: 'structured',
      value: { answer: 42 },
      final: true,
    });
    expect(finalResultText(validated)).toBeUndefined();
  });

  it.each([
    { label: 'none', parts: [] },
    {
      label: 'two',
      parts: [
        { kind: 'assistant', text: 'one', final: true },
        { kind: 'assistant', text: 'two', final: true },
      ],
    },
  ] satisfies Array<{ label: string; parts: AgentResult['parts'] }>)(
    'rejects a result with $label final parts',
    ({ parts }) => {
      expect(() => validateAgentResult(result(parts))).toThrow(
        'exactly one final part',
      );
    },
  );

  it('rejects malformed usage and duplicate capabilities', () => {
    expect(() => validateAgentResult(result(
      [{ kind: 'assistant', text: 'done', final: true }],
      { kind: 'reported', inputTokens: -1, outputTokens: 0 },
    ))).toThrow('inputTokens');

    expect(() => validateAgentResult({
      ...result([{ kind: 'assistant', text: 'done', final: true }]),
      effective: {
        ...selection,
        capabilities: ['read', 'read'],
      },
    })).toThrow('capabilities');

    expect(() => validateAgentResult({
      ...result([{ kind: 'assistant', text: 'done', final: true }]),
      transportFailure: {
        kind: 'not-real' as never,
        message: 'bad kind',
        exitCode: 1,
      },
    })).toThrow('transportFailure.kind');
  });

  it.each([
    { label: 'object', text: {} },
    { label: 'array', text: [] },
    { label: 'number', text: 7 },
    { label: 'boolean', text: false },
    { label: 'null', text: null },
  ])('rejects $label assistant text in complete and incomplete evidence', ({ text }) => {
    expect.soft(() => validateAgentResult(result([
      { kind: 'assistant', text: text as unknown as string, final: true },
    ]))).toThrow('parts[0].text must be a string');
    expect.soft(() => validateIncompleteResultEvidence(result([
      { kind: 'assistant', text: text as unknown as string, final: false },
    ]))).toThrow('parts[0].text must be a string');
  });

  it.each(['', 'answer'])('preserves valid assistant text %j in both validators', (text) => {
    expect(validateAgentResult(result([
      { kind: 'assistant', text, final: true },
    ])).parts).toEqual([{ kind: 'assistant', text, final: true }]);
    expect(validateIncompleteResultEvidence(result([
      { kind: 'assistant', text, final: false },
    ])).parts).toEqual([{ kind: 'assistant', text, final: false }]);
  });
});
