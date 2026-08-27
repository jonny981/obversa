import { isDeepStrictEqual } from 'node:util';

import { classifyEngineFailure, type EngineFailureKind } from './error.js';
import type {
  AgentRequest,
  AgentResult,
  AgentResultPart,
  Engine,
  EngineSelectionRecord,
  EngineStreamEvent,
} from './index.js';
import type { JsonValue } from './json.js';
import { validateAgentResult } from './result.js';

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
