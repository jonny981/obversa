import { isDeepStrictEqual } from 'node:util';

import { EngineError, classifyEngineFailure, type EngineFailureKind } from './error.js';
import type {
  AgentRequest,
  AgentResult,
  AgentResultPart,
  Engine,
  EngineSelectionRecord,
  EngineStreamEvent,
} from './contracts.js';
import type { JsonValue } from './json.js';
import { engineSelection, validateAgentResult } from './result.js';

export type EngineConformanceScenario =
  | 'ordered-parts'
  | 'structured-result'
  | 'unknown-usage'
  | 'reported-usage'
  | 'tool-events'
  | 'late-final'
  | 'cancellation'
  | 'missing-cli'
  | 'auth'
  | 'billing'
  | 'model-unavailable'
  | 'rate-limit'
  | 'quota'
  | 'transient'
  | 'timeout'
  | 'invalid-config';

export interface EngineConformanceFixture {
  readonly request: AgentRequest;
  readonly requested: EngineSelectionRecord;
  readonly effective: EngineSelectionRecord;
  /** Parse a final assistant part when the backend has no native schema mode. */
  readonly parseStructuredResult?: (
    part: AgentResultPart,
    parts: readonly AgentResultPart[],
  ) => JsonValue;
  open(scenario: EngineConformanceScenario): Engine | Promise<Engine>;
}

export interface EngineConformanceFailure {
  readonly case: string;
  readonly message: string;
}

export interface EngineConformanceReport {
  readonly ok: boolean;
  readonly cases: number;
  readonly failures: readonly EngineConformanceFailure[];
}

interface ConformanceCase {
  readonly name: string;
  run(): Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function check(condition: unknown, failure: string): asserts condition {
  if (!condition) throw new Error(failure);
}

function requestFor(
  fixture: EngineConformanceFixture,
  scenario: EngineConformanceScenario,
): AgentRequest {
  return {
    ...fixture.request,
    ...(fixture.request.tools === undefined
      ? {}
      : { tools: [...fixture.request.tools] }),
    ...(fixture.request.allowedTools === undefined
      ? {}
      : { allowedTools: [...fixture.request.allowedTools] }),
    ...(fixture.request.attempt === undefined
      ? {}
      : {
          attempt: {
            ...fixture.request.attempt,
            path: [...fixture.request.attempt.path],
          },
        }),
    ...(fixture.request.env === undefined
      ? {}
      : { env: { ...fixture.request.env } }),
    ...(scenario === 'structured-result'
      ? {
          jsonSchema: {
            type: 'object',
            properties: { answer: { type: 'number' } },
            required: ['answer'],
            additionalProperties: false,
          },
        }
      : {}),
  };
}

async function openAndRun(
  fixture: EngineConformanceFixture,
  scenario: EngineConformanceScenario,
): Promise<{ readonly result: AgentResult; readonly events: readonly EngineStreamEvent[] }> {
  const engine = await fixture.open(scenario);
  const events: EngineStreamEvent[] = [];
  const result = validateAgentResult(await engine.run(
    requestFor(fixture, scenario),
    (event) => events.push(event),
    new AbortController().signal,
  ));
  check(
    isDeepStrictEqual(result.requested, fixture.requested),
    'Result changed the requested engine identity.',
  );
  check(
    isDeepStrictEqual(result.effective, fixture.effective),
    'Result changed the effective engine identity.',
  );
  return { result, events: Object.freeze(events) };
}

function usageEvents(events: readonly EngineStreamEvent[]): EngineStreamEvent[] {
  return events.filter((event) => event.type === 'usage');
}

async function expectFailure(
  fixture: EngineConformanceFixture,
  scenario: EngineConformanceScenario,
  expected: EngineFailureKind,
): Promise<void> {
  let error: unknown;
  try {
    const engine = await fixture.open(scenario);
    await engine.run(
      requestFor(fixture, scenario),
      () => {},
      new AbortController().signal,
    );
  } catch (caught) {
    error = caught;
  }
  check(error !== undefined, `${scenario} completed instead of failing.`);
  const actual = classifyEngineFailure(error);
  check(
    actual === expected,
    `${scenario} classified as ${actual} instead of ${expected}.`,
  );
}

function withDeadline<Value>(
  promise: Promise<Value>,
  milliseconds: number,
): Promise<Value> {
  return new Promise<Value>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Engine did not settle after cancellation.')),
      milliseconds,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Run framework-free behavioral checks against an outside Engine adapter. */
export async function runEngineConformance(
  fixture: EngineConformanceFixture,
): Promise<EngineConformanceReport> {
  check(
    typeof fixture === 'object'
      && fixture !== null
      && typeof fixture.open === 'function',
    'Engine conformance fixture must provide open().',
  );
  check(
    typeof fixture.request?.prompt === 'string'
      && fixture.request.prompt.length > 0,
    'Engine conformance request must have a prompt.',
  );

  const cases: readonly ConformanceCase[] = [
    {
      name: 'ordered result parts',
      async run() {
        const { result, events } = await openAndRun(fixture, 'ordered-parts');
        check(
          isDeepStrictEqual(result.parts, [
            { kind: 'assistant', text: 'draft', final: false },
            { kind: 'assistant', text: 'answer', final: true },
          ]),
          'Engine did not preserve the two ordered assistant parts.',
        );
        check(
          events.filter((event) => event.type === 'text')
            .map((event) => event.delta)
            .join('|') === 'draft|answer',
          'Engine did not stream ordered text observations.',
        );
      },
    },
    {
      name: 'structured result',
      async run() {
        const { result } = await openAndRun(fixture, 'structured-result');
        const final = result.parts.find((part) => part.final);
        check(final !== undefined, 'Engine did not return a final result part.');
        const value = final.kind === 'structured'
          ? final.value
          : fixture.parseStructuredResult?.(final, result.parts);
        check(
          isDeepStrictEqual(value, { answer: 42 }),
          'Engine did not return a usable structured value.',
        );
      },
    },
    {
      name: 'unknown usage remains unknown',
      async run() {
        const { result, events } = await openAndRun(fixture, 'unknown-usage');
        check(result.usage.kind === 'unknown', 'Engine invented a usage receipt.');
        const streamed = usageEvents(events);
        check(
          streamed.length === 1
            && streamed[0]?.type === 'usage'
            && streamed[0].usage.kind === 'unknown',
          'Engine did not emit exactly one unknown usage observation.',
        );
      },
    },
    {
      name: 'reported usage stays measured',
      async run() {
        const { result, events } = await openAndRun(fixture, 'reported-usage');
        check(
          isDeepStrictEqual(result.usage, {
            kind: 'reported',
            inputTokens: 5,
            outputTokens: 3,
          }),
          'Engine changed the reported token receipt.',
        );
        const streamed = usageEvents(events);
        check(
          streamed.length === 1
            && streamed[0]?.type === 'usage'
            && isDeepStrictEqual(streamed[0].usage, result.usage),
          'Engine did not emit exactly one matching usage observation.',
        );
      },
    },
    {
      name: 'tool observations stay ordered',
      async run() {
        const { events } = await openAndRun(fixture, 'tool-events');
        const tools = events.filter((event) => event.type === 'tool');
        const expectedTool = fixture.request.tools?.[0];
        check(
          typeof expectedTool === 'string' && expectedTool.length > 0,
          'Tool conformance requires one declared request tool.',
        );
        check(
          isDeepStrictEqual(tools, [
            { type: 'tool', name: expectedTool, phase: 'use' },
            { type: 'tool', name: expectedTool, phase: 'result' },
          ]),
          'Engine lost or reordered visible tool observations.',
        );
      },
    },
    {
      name: 'late final survives transport failure',
      async run() {
        const { result } = await openAndRun(fixture, 'late-final');
        check(
          result.parts.some((part) => part.final),
          'Late result lost its marked final part.',
        );
        check(
          result.transportFailure !== undefined,
          'Late result hid the later transport failure.',
        );
        check(
          result.transportFailure.kind === 'unknown',
          'Engine classified words in completed output as the transport failure.',
        );
      },
    },
    {
      name: 'in-flight cancellation',
      async run() {
        const controller = new AbortController();
        const engine = await fixture.open('cancellation');
        let sawEvent = false;
        let error: unknown;
        try {
          await withDeadline(engine.run(
            requestFor(fixture, 'cancellation'),
            () => {
              sawEvent = true;
              controller.abort();
            },
            controller.signal,
          ), 3_000);
        } catch (caught) {
          error = caught;
        }
        check(sawEvent, 'Cancellation fixture never began streaming.');
        check(error !== undefined, 'Cancelled engine completed successfully.');
        check(
          classifyEngineFailure(error) === 'aborted',
          `Cancellation classified as ${classifyEngineFailure(error)} instead of aborted.`,
        );
      },
    },
    ...([
      ['missing-cli', 'missing-cli'],
      ['auth', 'auth'],
      ['billing', 'billing'],
      ['model-unavailable', 'model-unavailable'],
      ['rate-limit', 'rate-limit'],
      ['quota', 'quota'],
      ['transient', 'transient'],
      ['timeout', 'timeout'],
      ['invalid-config', 'invalid-config'],
    ] as const).map(([scenario, expected]) => ({
      name: `${scenario} failure classification`,
      run: () => expectFailure(fixture, scenario, expected),
    })),
  ];

  const failures: EngineConformanceFailure[] = [];
  for (const item of cases) {
    try {
      await item.run();
    } catch (error) {
      failures.push({ case: item.name, message: message(error) });
    }
  }
  return Object.freeze({
    ok: failures.length === 0,
    cases: cases.length,
    failures: Object.freeze(failures.map((item) => Object.freeze(item))),
  });
}

/** Throw one readable error when an outside Engine breaks the contract. */
export async function assertEngineConformance(
  fixture: EngineConformanceFixture,
): Promise<void> {
  const report = await runEngineConformance(fixture);
  if (report.ok) return;
  const detail = report.failures
    .map((item) => `${item.case}: ${item.message}`)
    .join('; ');
  throw new Error(`Engine conformance failed: ${detail}`);
}

export interface EngineAdmissionConformanceFixture {
  readonly request: AgentRequest;
  readonly selection: EngineSelectionRecord;
  open(): Engine | Promise<Engine>;
  /** No argument counts all model calls; a path/null counts that target. */
  modelCalls(executable?: string | null): number | Promise<number>;
  readonly cli?: {
    /** Move bare-name lookup while keeping the admitted path runnable. */
    moveLookup(): void | Promise<void>;
    /** Same configuration, except an explicitly different absolute path. */
    openDifferent(): Engine | Promise<Engine>;
    /** A syntactically valid absolute path with no executable. */
    openMissing(): Engine | Promise<Engine>;
  };
}

export type EngineAdmissionConformanceReport = EngineConformanceReport | {
  readonly kind: 'unsupported';
  readonly adapter: string;
};

class AdmissionUnsupportedError extends Error {
  constructor(readonly adapter: string) {
    super(`${adapter} does not implement admit`);
  }
}

/** Check optional admission without imposing the full run-scenario protocol. */
export async function runEngineAdmissionConformance(
  fixture: EngineAdmissionConformanceFixture,
): Promise<EngineAdmissionConformanceReport> {
  const failures: EngineConformanceFailure[] = [];
  let cases = 0;
  let unsupported: Extract<EngineAdmissionConformanceReport, { kind: 'unsupported' }>
    | undefined;

  const report = (): EngineAdmissionConformanceReport => unsupported ?? Object.freeze({
    ok: failures.length === 0,
    cases,
    failures: Object.freeze(failures.map((failure) => Object.freeze(failure))),
  });
  const runCase = async <Value>(
    name: string,
    action: () => Promise<Value>,
  ): Promise<Value | undefined> => {
    if (unsupported) return;
    cases += 1;
    try {
      return await action();
    } catch (error) {
      if (error instanceof AdmissionUnsupportedError) {
        unsupported = Object.freeze({ kind: 'unsupported', adapter: error.adapter });
      } else {
        failures.push({ case: name, message: message(error) });
      }
    }
  };
  const method = (engine: Engine): NonNullable<Engine['admit']> => {
    if (typeof engine.admit !== 'function') throw new AdmissionUnsupportedError(engine.name);
    return engine.admit.bind(engine);
  };
  const request = (): Omit<AgentRequest, 'prompt'> => {
    const { prompt: _prompt, ...rest } = structuredClone(fixture.request);
    return rest;
  };
  const noModelCall = async <Value>(action: () => Promise<Value>): Promise<Value> => {
    const before = await fixture.modelCalls();
    try {
      return await action();
    } finally {
      check(await fixture.modelCalls() === before, 'Admission or refusal made a model call.');
    }
  };
  const expectFailureKind = async (
    action: () => Promise<unknown>,
    kind: EngineFailureKind,
  ): Promise<void> => {
    let error: unknown;
    try { await action(); } catch (caught) { error = caught; }
    if (error instanceof AdmissionUnsupportedError) throw error;
    check(error instanceof EngineError && error.kind === kind,
      `Expected a typed ${kind} failure, got ${error === undefined ? 'success' : message(error)}.`);
  };
  const signal = (): AbortSignal => new AbortController().signal;
  const runSelected = async (engine: Engine, selected: EngineSelectionRecord): Promise<void> => {
    const total = await fixture.modelCalls();
    const atPath = await fixture.modelCalls(selected.executable);
    const result = validateAgentResult(await engine.run(
      structuredClone(fixture.request), () => {}, signal(),
    ));
    check(isDeepStrictEqual(result.requested, selected), 'Run changed its admitted requested identity.');
    check(isDeepStrictEqual(result.effective, selected), 'Run changed its admitted effective identity.');
    check(await fixture.modelCalls() === total + 1, 'Run did not make exactly one fixture model call.');
    check(await fixture.modelCalls(selected.executable) === atPath + 1,
      'Run used a different executable from its admitted selection.');
  };

  const initial = await runCase('initial admission', async () => {
    const engine = await fixture.open();
    const admit = method(engine);
    const selected = engineSelection(fixture.selection);
    check((selected.executable !== null) === (fixture.cli !== undefined),
      'CLI selection requires CLI controls; a null executable must not supply them.');
    const admitted = await noModelCall(async () => engineSelection(await admit(request(), signal())));
    check(isDeepStrictEqual(admitted, selected), 'Admission changed the expected selection.');
    return { engine, selection: admitted };
  });
  if (!initial) return report();
  const first = initial.engine;
  const selected = initial.selection;

  await runCase('same instance retains selection', async () => {
    await fixture.cli?.moveLookup();
    const again = await noModelCall(async () => engineSelection(
      await method(first)(request(), signal(), selected),
    ));
    check(isDeepStrictEqual(again, selected), 'Re-admission changed the saved selection.');
    await runSelected(first, selected);
  });

  await runCase('replacement restores selection', async () => {
    const replacement = await fixture.open();
    const restored = await noModelCall(async () => engineSelection(
      await method(replacement)(request(), signal(), selected),
    ));
    check(isDeepStrictEqual(restored, selected), 'Replacement did not restore the saved selection.');
    await runSelected(replacement, selected);
  });

  const changed: ReadonlyArray<readonly [string, EngineSelectionRecord]> = [
    ['adapter', engineSelection({ ...selected, adapter: `${selected.adapter}-different` })],
    ['provider', engineSelection({ ...selected, provider: `${selected.provider ?? ''}-different` })],
    ['family', engineSelection({ ...selected, modelFamily: `${selected.modelFamily ?? ''}-different` })],
    ['model', engineSelection({ ...selected, model: `${selected.model ?? ''}-different` })],
    ['capabilities', engineSelection({
      ...selected, capabilities: selected.capabilities.length === 0 ? ['different'] : [],
    })],
    ['version', engineSelection({ ...selected, adapterVersion: `${selected.adapterVersion ?? ''}-different` })],
  ];
  for (const [field, expected] of changed) {
    await runCase(`changed ${field} is refused`, async () => {
      await noModelCall(async () => expectFailureKind(
        async () => method(first)(request(), signal(), expected), 'invalid-config',
      ));
    });
  }

  if (fixture.cli) {
    const cli = fixture.cli;
    await runCase('explicitly swapped path is refused', async () => {
      await noModelCall(async () => {
        const different = await cli.openDifferent();
        const other = engineSelection(await method(different)(request(), signal()));
        check(other.executable !== null && other.executable !== selected.executable,
          'Different-executable fixture did not select a different path.');
        check(isDeepStrictEqual({ ...other, executable: selected.executable }, selected),
          'Different-executable fixture also changed non-path identity.');
        const freshDifferent = await cli.openDifferent();
        await expectFailureKind(
          async () => method(freshDifferent)(request(), signal(), selected), 'invalid-config',
        );
        await expectFailureKind(
          async () => method(first)(request(), signal(), other), 'invalid-config',
        );
      });
    });
    await runCase('missing executable fails after construction', async () => {
      await noModelCall(async () => {
        const missing = await cli.openMissing();
        await expectFailureKind(async () => method(missing)(request(), signal()), 'missing-cli');
        await expectFailureKind(async () => missing.run(
          structuredClone(fixture.request), () => {}, signal(),
        ), 'missing-cli');
        const freshMissing = await cli.openMissing();
        method(freshMissing);
        await expectFailureKind(async () => freshMissing.run(
          structuredClone(fixture.request), () => {}, signal(),
        ), 'missing-cli');
      });
    });
  }
  return report();
}
