import {
  createGraphKernel,
  type GraphDefinition,
} from './graph/kernel.js';
import type { GraphEvent } from './graph/type.js';
import {
  cloneFrozenJson,
  GraphValidationError,
  JsonValueError,
  type JsonValue,
} from './graph/value.js';

export function defineGraphDefinition<const Definition extends GraphDefinition>(
  input: Definition,
): Definition {
  return createGraphKernel(input).definition.value;
}

export interface GraphEventTrace<Event extends GraphEvent = GraphEvent> {
  readonly events: readonly Event[];
  record<Next extends Event>(event: Next): Next;
}

function checkedEvent<Event extends GraphEvent>(input: Event): Event {
  let event: Event;
  try {
    event = cloneFrozenJson(input as unknown as JsonValue) as unknown as Event;
  } catch (error) {
    if (!(error instanceof JsonValueError)) throw error;
    throw new GraphValidationError('Invalid graph event.', [{
      code: 'INVALID_GRAPH_EVENT',
      path: error.path,
      message: error.message,
    }]);
  }
  if (
    event === null
    || typeof event !== 'object'
    || Array.isArray(event)
    || Object.keys(event).sort().join(',') !== 'payload,type,version'
    || typeof event.type !== 'string'
    || event.type.trim().length === 0
    || !Number.isSafeInteger(event.version)
    || event.version < 1
  ) {
    throw new GraphValidationError('Invalid graph event.', [{
      code: 'INVALID_GRAPH_EVENT',
      path: '',
      message: 'An event must contain a non-empty type, positive version, and JSON payload.',
    }]);
  }
  return event;
}

export function createGraphEventTrace<Event extends GraphEvent>(
  seed: readonly Event[] = [],
): GraphEventTrace<Event> {
  let ordered = Object.freeze(seed.map(checkedEvent));
  return Object.freeze({
    get events(): readonly Event[] {
      return ordered;
    },
    record<Next extends Event>(event: Next): Next {
      const checked = checkedEvent(event);
      ordered = Object.freeze([...ordered, checked]);
      return checked;
    },
  });
}

export {
  MockEngine,
  mockVerdict,
  type MockResponder,
} from './engines/mock.js';
export {
  MockEnvironment,
  type MockEnvOptions,
} from './env/mock.js';
export {
  runGraphTypeConformance,
  assertGraphTypeConformance,
  type GraphTypeConformanceFixture,
  type GraphTypeConformanceFailure,
  type GraphTypeConformanceReport,
} from './graph/conformance.js';
export {
  runEventStoreConformance,
  assertEventStoreConformance,
  type EventStoreConformanceFactory,
  type EventStoreConformanceFailure,
  type EventStoreConformanceReport,
} from './events/conformance.js';
export {
  runArtifactStoreConformance,
  assertArtifactStoreConformance,
  type ArtifactStoreConformanceOptions,
  type ArtifactStoreConformanceFactory,
  type ArtifactStoreConformanceFailure,
  type ArtifactStoreConformanceReport,
} from './artifacts/conformance.js';
export {
  runEngineConformance,
  assertEngineConformance,
  type EngineConformanceScenario,
  type EngineConformanceFixture,
  type EngineConformanceFailure,
  type EngineConformanceReport,
} from '@obversa/engine/testing';
