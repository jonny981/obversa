import { isDeepStrictEqual } from 'node:util';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  EngineError,
  assistantResult,
  engineSelection,
  isEngine,
  runEngineAdmissionConformance,
  type AgentRequest,
  type Engine,
  type EngineAdmissionConformanceFixture,
  type EngineAdmissionConformanceReport,
  type EngineConformanceReport,
  type EngineSelectionRecord,
} from '../src/index.ts';
import {
  runEngineAdmissionConformance as testingEntry,
} from '../src/testing.ts';

type Defect =
  | 'spend-during-admit'
  | 'resolve-again'
  | 'restore-from-lookup'
  | 'ignore-expected'
  | 'ignore-version'
  | 'wrong-record'
  | 'stale-requested'
  | 'wrong-effective'
  | 'run-other-executable'
  | 'missing-constructor'
  | 'missing-run'
  | 'untyped-missing'
  | 'unsupported'
  | 'replacement-unsupported';

function fixture(options: {
  api?: boolean;
  defect?: Defect;
} = {}): EngineAdmissionConformanceFixture {
  const api = options.api ?? false;
  const selected = engineSelection({
    adapter: api ? 'fixture-api' : 'fixture-cli',
    adapterVersion: api ? null : '1.2.3',
    provider: 'fixture-provider',
    modelFamily: 'fixture-family',
    model: 'fixture-model',
    executable: api ? null : '/fixture/a/engine',
    capabilities: ['read'],
  });
  let lookup = '/fixture/a/engine';
  let opened = 0;
  const calls: Array<string | null> = [];
  const invalid = () => new EngineError({
    kind: 'invalid-config',
    message: 'fixture selection changed',
  });
  const missing = () => options.defect === 'untyped-missing'
    ? new Error('fixture command not found')
    : new EngineError({ kind: 'missing-cli', message: 'fixture binary missing' });

  function make(explicit?: string, absent = false): Engine {
    if (absent && options.defect === 'missing-constructor') throw missing();
    let bound: EngineSelectionRecord | undefined;
    const engine: Engine = {
      name: selected.adapter,
      async admit(request, _signal, expected) {
        expect(this).toBe(engine);
        expect('prompt' in request).toBe(false);
        expect(request).toMatchObject({
          model: 'fixture-model',
          tools: ['read'],
          allowedTools: ['Read'],
          workspaceMode: 'read',
          cwd: '/tmp',
          leaf: true,
        });
        if (options.defect === 'spend-during-admit') calls.push(selected.executable);
        if (absent) throw missing();
        const executable = api
          ? null
          : options.defect === 'resolve-again'
            ? explicit ?? lookup
            : bound?.executable
              ?? explicit
              ?? (options.defect === 'restore-from-lookup' ? undefined : expected?.executable)
              ?? lookup;
        const proposed = engineSelection({ ...selected, executable });
        if (options.defect !== 'ignore-expected') {
          if (expected && explicit !== undefined && expected.executable !== explicit) {
            throw invalid();
          }
          const compared = options.defect === 'ignore-version' && expected
            ? { ...expected, adapterVersion: proposed.adapterVersion }
            : expected;
          if (compared && !isDeepStrictEqual(compared, proposed)) throw invalid();
        }
        bound = proposed;
        return options.defect === 'wrong-record'
          ? engineSelection({ ...proposed, model: 'invented-model' })
          : proposed;
      },
      async run(request, _onEvent, signal) {
        expect(this).toBe(engine);
        if (absent && options.defect !== 'missing-run') throw missing();
        if (!bound) {
          if (absent) bound = selected;
          else {
            const { prompt: _prompt, ...withoutPrompt } = request;
            bound = await engine.admit!(withoutPrompt, signal);
          }
        }
        calls.push(options.defect === 'run-other-executable' ? '/fixture/b/engine' : bound.executable);
        const requested = options.defect === 'stale-requested'
          ? engineSelection({ ...bound, adapterVersion: 'stale-version' })
          : bound;
        return assistantResult({
          text: 'fixture answer',
          usage: { kind: 'unknown' },
          requested,
          ...(options.defect === 'wrong-effective' ? {
            effective: engineSelection({ ...bound, executable: api ? null : '/fixture/b/engine', model: 'different-model' }),
          } : {}),
        });
      },
    };
    return engine;
  }

  return {
    request: {
      prompt: 'Check this engine.',
      model: 'fixture-model',
      tools: ['read'],
      allowedTools: ['Read'],
      workspaceMode: 'read',
      cwd: '/tmp',
      timeoutMs: 1_000,
      leaf: true,
    },
    selection: selected,
    open() {
      opened += 1;
      const engine = make();
      if (options.defect === 'unsupported'
        || (options.defect === 'replacement-unsupported' && opened > 1)) {
        return { name: engine.name, run: engine.run };
      }
      return engine;
    },
    modelCalls(executable) {
      return executable === undefined
        ? calls.length
        : calls.filter((path) => path === executable).length;
    },
    ...(api ? {} : {
      cli: {
        moveLookup() { lookup = '/fixture/b/engine'; },
        openDifferent() { return make('/fixture/b/engine'); },
        openMissing() { return make('/fixture/missing/engine', true); },
      },
    }),
  };
}

function supported(report: EngineAdmissionConformanceReport): EngineConformanceReport {
  if ('kind' in report) throw new Error(`Unexpected ${report.kind}: ${report.adapter}`);
  return report;
}

describe('optional engine admission conformance', () => {
  it('exports the same entry through root and testing', () => {
    expect(testingEntry).toBe(runEngineAdmissionConformance);
  });

  it('keeps old engines valid and the request marker optional', () => {
    const old: Engine = {
      name: 'legacy',
      async run() {
        return assistantResult({
          text: 'legacy result',
          usage: { kind: 'unknown' },
          requested: engineSelection({ adapter: 'legacy' }),
        });
      },
    };
    const ordinary: AgentRequest = { prompt: 'ordinary' };
    const preflight: AgentRequest = { prompt: 'probe', purpose: 'preflight' };
    expect(isEngine(old)).toBe(true);
    expect(ordinary.purpose).toBeUndefined();
    expect(preflight.purpose).toBe('preflight');
    expectTypeOf<AgentRequest['purpose']>().toEqualTypeOf<'preflight' | undefined>();
    expectTypeOf<NonNullable<Engine['admit']>>().toEqualTypeOf<(
      request: Omit<AgentRequest, 'prompt'>,
      signal: AbortSignal,
      expectedSelection?: EngineSelectionRecord,
    ) => Promise<EngineSelectionRecord>>();
  });

  it.each([false, true])('passes a conforming fixture (API=%s)', async (api) => {
    const input = fixture({ api });
    const report = supported(await runEngineAdmissionConformance(input));
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.cases).toBe(api ? 9 : 11);
    expect(await input.modelCalls()).toBe(2);
    expect(await input.modelCalls(input.selection.executable)).toBe(2);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.failures)).toBe(true);
  });

  it.each(['unsupported', 'replacement-unsupported'] as const)(
    'reports %s without a success or failure report', async (defect) => {
      const input = fixture({ defect });
      const report = await runEngineAdmissionConformance(input);
      expect(report).toEqual({ kind: 'unsupported', adapter: 'fixture-cli' });
      expect('ok' in report).toBe(false);
      expect('failures' in report).toBe(false);
      if (defect === 'unsupported') expect(await input.modelCalls()).toBe(0);
    },
  );

  it.each([
    ['spend-during-admit', 'initial admission'],
    ['wrong-record', 'initial admission'],
    ['resolve-again', 'same instance retains selection'],
    ['restore-from-lookup', 'replacement restores selection'],
    ['ignore-expected', 'changed model is refused'],
    ['ignore-version', 'changed version is refused'],
    ['stale-requested', 'same instance retains selection'],
    ['wrong-effective', 'same instance retains selection'],
    ['run-other-executable', 'same instance retains selection'],
    ['missing-constructor', 'missing executable fails after construction'],
    ['missing-run', 'missing executable fails after construction'],
    ['untyped-missing', 'missing executable fails after construction'],
  ] satisfies ReadonlyArray<readonly [Defect, string]>)(
    'catches %s', async (defect, expectedCase) => {
      const report = supported(await runEngineAdmissionConformance(fixture({ defect })));
      expect(report.ok).toBe(false);
      expect(report.failures.map((failure) => failure.case)).toContain(expectedCase);
    },
  );

  it('requires CLI fixture controls instead of silently skipping path checks', async () => {
    const { cli: _cli, ...withoutControls } = fixture();
    const report = supported(await runEngineAdmissionConformance(withoutControls));
    expect(report.failures).toEqual([
      expect.objectContaining({ case: 'initial admission' }),
    ]);
  });

  it('refuses fake CLI controls on a process-free fixture', async () => {
    const report = supported(await runEngineAdmissionConformance({
      ...fixture({ api: true }),
      cli: fixture().cli!,
    }));
    expect(report.failures).toEqual([
      expect.objectContaining({ case: 'initial admission' }),
    ]);
  });
});
