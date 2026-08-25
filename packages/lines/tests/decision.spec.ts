import { describe, it, expect } from 'vitest';

import {
  confidenceCondition,
  confidenceFromText,
  fnJob,
  lastDecisionLine,
  lastGateBrief,
  run,
  type Condition,
  type ConditionResult,
} from '../src/api.ts';

async function evaluate(condition: Condition): Promise<ConditionResult> {
  const results: ConditionResult[] = [];
  await run(
    fnJob('evaluate-condition', async (ctx) => {
      results.push(await condition(ctx, undefined));
      return { status: 'pass' };
    }),
  );
  return results[0]!;
}

describe('decision-token helpers', () => {
  it('returns only a closing decision line', () => {
    const text = [
      '<decision>retry</decision>',
      'inline decision: fail',
      'decision: pass',
    ].join('\n');

    expect(lastDecisionLine(text, 'decision', ['pass', 'fail'])).toBe('pass');
    expect(lastDecisionLine('decision: pass\nunresolved caveat', 'decision')).toBeUndefined();
  });

  it('returns the canonical vocabulary casing, not the leaf casing', () => {
    // A chatty leaf may close with `VERDICT: pass`; a gate comparing the
    // return against its declared vocabulary (`=== 'PASS'`) must still match.
    expect(
      lastDecisionLine('VERDICT: pass', 'VERDICT', ['PASS', 'CONCERNS'], {
        mode: 'last-match',
      }),
    ).toBe('PASS');
    expect(lastDecisionLine('verdict: Concerns', 'VERDICT', ['PASS', 'CONCERNS'])).toBe(
      'CONCERNS',
    );
    // The vocabulary's own casing is authoritative, whatever it is.
    expect(lastDecisionLine('DECISION: PASS', 'decision', ['pass', 'fail'])).toBe('pass');
    // Without a vocabulary there is nothing to canonicalize to.
    expect(lastDecisionLine('decision: Pass', 'decision')).toBe('Pass');
  });

  it('can select the last anchored decision before trailing chatter', () => {
    expect(
      lastDecisionLine(
        'decision: fail\n<decision>pass</decision>\nunresolved caveat',
        'decision',
        ['pass', 'fail'],
        { mode: 'last-match' },
      ),
    ).toBe('pass');
    expect(
      lastDecisionLine(
        'decision: pass\ndecision: retry\nunresolved caveat',
        'decision',
        ['pass', 'fail'],
        { mode: 'last-match' },
      ),
    ).toBeUndefined();
  });

  it('parses confidence tags as percentages or fractions', () => {
    expect(confidenceFromText('<confidence>87%</confidence>')).toBe(0.87);
    expect(confidenceFromText('confidence: 0.62')).toBe(0.62);
    expect(confidenceFromText('confidence: nope')).toBeUndefined();
  });

  it('lifts a job into a confidence condition fail-closed', async () => {
    const condition = confidenceCondition(
      fnJob('reader', async () => ({
        status: 'pass',
        summary: '<confidence>91%</confidence>',
      })),
      { threshold: 0.9 },
    );
    const result = await run(
      fnJob('gate', async (ctx) => {
        const gate = await condition(ctx, undefined);
        return { status: gate.met ? 'pass' : 'fail', confidence: gate.confidence };
      }),
    );
    expect(result.outcome.status).toBe('pass');
    expect(result.outcome.confidence).toBe(0.91);
  });

  it.each(['<confidence>N/A</confidence>', 'confidence: n/A'])(
    'accepts an exact case-insensitive n/a token when enabled: %s',
    async (summary) => {
      const result = await evaluate(
        confidenceCondition(
          fnJob('reader', async () => ({ status: 'pass', summary })),
          { allowNa: true },
        ),
      );

      expect(result.met).toBe(true);
      expect(result.confidence).toBe(1);
    },
  );

  it('keeps n/a fail-closed by default and for failed jobs', async () => {
    const defaultResult = await evaluate(
      confidenceCondition(
        fnJob('reader', async () => ({
          status: 'pass',
          summary: 'confidence: n/a',
        })),
      ),
    );
    const failedResult = await evaluate(
      confidenceCondition(
        fnJob('reader', async () => ({
          status: 'fail',
          summary: 'confidence: n/a',
        })),
        { allowNa: true },
      ),
    );
    const inexactResult = await evaluate(
      confidenceCondition(
        fnJob('reader', async () => ({
          status: 'pass',
          summary: 'confidence: n/a because no score applies',
        })),
        { allowNa: true },
      ),
    );

    expect(defaultResult).toMatchObject({ met: false, confidence: 0 });
    expect(failedResult).toMatchObject({ met: false, confidence: 0 });
    expect(inexactResult).toMatchObject({ met: false, confidence: 0 });
  });

  it('supports percent-scale thresholds while returning normalized confidence', async () => {
    const passing = await evaluate(
      confidenceCondition(
        fnJob('reader', async () => ({
          status: 'pass',
          summary: 'confidence: 100%',
        })),
        { scale: 'percent', threshold: 100 },
      ),
    );
    const failing = await evaluate(
      confidenceCondition(
        fnJob('reader', async () => ({
          status: 'pass',
          summary: 'confidence: 99%',
        })),
        { scale: 'percent', threshold: 100 },
      ),
    );
    const defaultThreshold = await evaluate(
      confidenceCondition(
        fnJob('reader', async () => ({
          status: 'pass',
          summary: 'confidence: 80%',
        })),
        { scale: 'percent' },
      ),
    );

    expect(passing).toMatchObject({ met: true, confidence: 1 });
    expect(failing).toMatchObject({ met: false, confidence: 0.99 });
    expect(defaultThreshold.met).toBe(true);
  });

  it('can use the full work output as its reason without changing the default', async () => {
    const output = 'Core workflow did not run.\nconfidence: 20%';
    const concise = await evaluate(
      confidenceCondition(
        fnJob('reader', async () => ({ status: 'pass', data: output })),
        { threshold: 0.8 },
      ),
    );
    const detailed = await evaluate(
      confidenceCondition(
        fnJob('reader', async () => ({ status: 'pass', data: output })),
        { threshold: 0.8, reason: 'output' },
      ),
    );

    expect(concise.reason).toBe('confidence 0.20 below threshold 0.80');
    expect(detailed.reason).toBe(output);
    expect(detailed.output).toBe(output);
  });

  it('renders a compact last gate brief only for failed gates', () => {
    expect(lastGateBrief({ lastGate: undefined })).toBe('');
    expect(lastGateBrief({ lastGate: { met: true, reason: 'ok' } })).toBe('');
    expect(
      lastGateBrief(
        { lastGate: { met: false, reason: 'tests failed', output: 'x'.repeat(20) } },
        { maxOutputChars: 5 },
      ),
    ).toContain('xxxxx\n[gate output truncated]');
  });
});
