import { isDeepStrictEqual } from 'node:util';

import type { GraphDefinition } from './kernel.js';
import type { GraphCommand } from './commands.js';
import {
  resolveGraphPlan,
  type GraphBounds,
  type GraphRequirements,
  type PlanResolution,
} from './plan.js';
import {
  compileGraph,
  type GraphEvent,
  type GraphType,
} from './type.js';
import { GraphValidationError, type JsonValue } from './value.js';

export interface GraphTypeConformanceFixture<
  Definition extends GraphDefinition = GraphDefinition,
  State extends JsonValue = JsonValue,
  Event extends GraphEvent = GraphEvent,
  Requirements extends GraphRequirements = GraphRequirements,
> {
  readonly graphType: GraphType<Definition, State, Event, Requirements>;
  readonly definition: Definition;
  readonly events: readonly Event[];
  readonly invalidDefinitions: readonly [Definition, ...Definition[]];
  readonly planResolution: PlanResolution;
  readonly expected: {
    /** Initial state followed by the state after each event prefix. */
    readonly states: readonly [State, ...State[]];
    /** Ordered decision at the initial state and after each event prefix. */
    readonly commands: readonly [readonly GraphCommand[], ...(readonly GraphCommand[])[]];
    readonly bounds: GraphBounds;
  };
}

export interface GraphTypeConformanceFailure {
  readonly case: string;
  readonly message: string;
}

export interface GraphTypeConformanceReport {
  readonly ok: boolean;
  readonly cases: number;
  readonly failures: readonly GraphTypeConformanceFailure[];
}

interface ConformanceCase {
  readonly name: string;
  run(): void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertExpectedDecisionTraceFitsBounds(
  decisions: readonly (readonly GraphCommand[])[],
  bounds: GraphBounds,
): void {
  const dispatchCounts = decisions.map(
    (commands) => commands.filter((command) => command.kind === 'dispatch').length,
  );
  const totalDispatches = dispatchCounts.reduce((total, count) => total + count, 0);
  const maxFanOut = dispatchCounts.reduce(
    (maximum, count) => Math.max(maximum, count),
    0,
  );
  const finalDecision = decisions.at(-1);
  const completed = finalDecision?.length === 1
    && finalDecision[0]?.kind === 'complete';

  if (
    completed
    && bounds.dispatches.min.kind === 'known'
    && totalDispatches < bounds.dispatches.min.value
  ) {
    const unit = totalDispatches === 1 ? 'dispatch command' : 'dispatch commands';
    throw new Error(
      `Completed trace contains ${totalDispatches} ${unit}, below declared minimum ${bounds.dispatches.min.value}.`,
    );
  }

  if (
    bounds.dispatches.max.kind === 'known'
    && totalDispatches > bounds.dispatches.max.value
  ) {
    throw new Error(
      `Expected decision trace contains ${totalDispatches} dispatch commands, above declared maximum ${bounds.dispatches.max.value}.`,
    );
  }
  if (
    bounds.maxFanOut.kind === 'known'
    && maxFanOut > bounds.maxFanOut.value
  ) {
    throw new Error(
      `Expected decision trace has fan-out ${maxFanOut}, above declared maximum ${bounds.maxFanOut.value}.`,
    );
  }
}

/** Run the framework-free behavioral checks for an outside graph type. */
export function runGraphTypeConformance<
  Definition extends GraphDefinition,
  State extends JsonValue,
  Event extends GraphEvent,
  Requirements extends GraphRequirements,
>(
  fixture: GraphTypeConformanceFixture<Definition, State, Event, Requirements>,
): GraphTypeConformanceReport {
  const cases: ConformanceCase[] = [
    {
      name: 'deterministic compile',
      run() {
        const first = compileGraph(fixture.graphType, fixture.definition);
        const second = compileGraph(fixture.graphType, fixture.definition);
        if (!isDeepStrictEqual(first.definition, second.definition)) {
          throw new Error('Repeated compile changed the definition snapshot.');
        }
        if (!isDeepStrictEqual(first.describe(), second.describe())) {
          throw new Error('Repeated compile changed the graph description.');
        }
        const initialStates = [
          first.initialState(),
          first.initialState(),
          second.initialState(),
          second.initialState(),
        ];
        if (initialStates.some(
          (state) => !isDeepStrictEqual(state, fixture.expected.states[0]),
        )) {
          throw new Error('Repeated compile or initialState changed the expected initial state.');
        }
      },
    },
    {
      name: 'deterministic replay',
      run() {
        if (fixture.expected.states.length !== fixture.events.length + 1) {
          throw new Error('Expected states must cover the initial state and every event prefix.');
        }
        const first = compileGraph(fixture.graphType, fixture.definition);
        const second = compileGraph(fixture.graphType, fixture.definition);
        let firstState = first.initialState();
        let secondState = second.initialState();
        for (let index = 0; index < fixture.events.length; index += 1) {
          const event = fixture.events[index]!;
          const expected = fixture.expected.states[index + 1]!;
          const states = [
            first.reduce(firstState, event),
            first.reduce(firstState, event),
            second.reduce(secondState, event),
            second.reduce(secondState, event),
          ];
          if (states.some((state) => !isDeepStrictEqual(state, expected))) {
            throw new Error(`Repeated replay changed state after event prefix ${index + 1}.`);
          }
          firstState = states[0]!;
          secondState = states[2]!;
        }
      },
    },
    {
      name: 'deterministic decision',
      run() {
        if (fixture.expected.commands.length !== fixture.events.length + 1) {
          throw new Error('Expected commands must cover the initial state and every event prefix.');
        }
        const first = compileGraph(fixture.graphType, fixture.definition);
        const second = compileGraph(fixture.graphType, fixture.definition);
        let firstState = first.initialState();
        let secondState = second.initialState();
        for (let index = 0; index <= fixture.events.length; index += 1) {
          const expected = fixture.expected.commands[index]!;
          const commands = [
            first.decide(firstState),
            first.decide(firstState),
            second.decide(secondState),
            second.decide(secondState),
          ];
          if (commands.some((decision) => !isDeepStrictEqual(decision, expected))) {
            throw new Error(`Repeated decision changed the ordered command at event prefix ${index}.`);
          }
          const event = fixture.events[index];
          if (event) {
            firstState = first.reduce(firstState, event);
            secondState = second.reduce(secondState, event);
          }
        }
      },
    },
    {
      name: 'input immutability',
      run() {
        const definitionBefore = structuredClone(fixture.definition);
        const eventsBefore = structuredClone(fixture.events);
        const compiled = compileGraph(fixture.graphType, fixture.definition);
        let state = compiled.initialState();
        for (const event of fixture.events) state = compiled.reduce(state, event);
        compiled.decide(state);
        if (!isDeepStrictEqual(fixture.definition, definitionBefore)) {
          throw new Error('Graph code changed the caller definition.');
        }
        if (!isDeepStrictEqual(fixture.events, eventsBefore)) {
          throw new Error('Graph code changed caller events.');
        }
      },
    },
    {
      name: 'invalid definitions',
      run() {
        for (const invalid of fixture.invalidDefinitions) {
          try {
            compileGraph(fixture.graphType, invalid);
          } catch (error) {
            if (error instanceof GraphValidationError) continue;
            throw new Error(`Invalid definition returned ${message(error)} instead of GraphValidationError.`);
          }
          throw new Error('Invalid definition compiled successfully.');
        }
      },
    },
    {
      name: 'deterministic plan resolution',
      run() {
        const firstCompiled = compileGraph(fixture.graphType, fixture.definition);
        const secondCompiled = compileGraph(fixture.graphType, fixture.definition);
        const plans = [
          resolveGraphPlan(firstCompiled.describe(), fixture.planResolution),
          resolveGraphPlan(firstCompiled.describe(), fixture.planResolution),
          resolveGraphPlan(secondCompiled.describe(), fixture.planResolution),
          resolveGraphPlan(secondCompiled.describe(), fixture.planResolution),
        ];
        if (plans.some((plan) => !isDeepStrictEqual(plan, plans[0]))) {
          throw new Error('Repeated plan resolution changed the plan bytes or digest.');
        }
        if (!isDeepStrictEqual(plans[0]!.plan.bounds, fixture.expected.bounds)) {
          throw new Error('Resolved plan bounds do not match the fixture.');
        }
        assertExpectedDecisionTraceFitsBounds(
          fixture.expected.commands,
          plans[0]!.plan.bounds,
        );
      },
    },
  ];

  const failures: GraphTypeConformanceFailure[] = [];
  for (const item of cases) {
    try {
      item.run();
    } catch (error) {
      failures.push({ case: item.name, message: message(error) });
    }
  }
  return Object.freeze({
    ok: failures.length === 0,
    cases: cases.length,
    failures: Object.freeze(failures.map((failure) => Object.freeze(failure))),
  });
}

/** Throw one readable error when an outside graph type breaks the contract. */
export function assertGraphTypeConformance<
  Definition extends GraphDefinition,
  State extends JsonValue,
  Event extends GraphEvent,
  Requirements extends GraphRequirements,
>(
  fixture: GraphTypeConformanceFixture<Definition, State, Event, Requirements>,
): void {
  const report = runGraphTypeConformance(fixture);
  if (report.ok) return;
  const detail = report.failures
    .map((failure) => `${failure.case}: ${failure.message}`)
    .join('; ');
  throw new Error(`Graph type conformance failed: ${detail}`);
}
