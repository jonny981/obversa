import {
  validateNewDomainEvent,
  type DomainEventEnvelope,
  type EventStreamRef,
  type NewDomainEvent,
} from '../events/envelope.js';
import type { DomainEventBatch } from '../events/store.js';
import { StorageError } from '../storage/error.js';
import {
  loadRunDefinition,
  type RunStorageBinding,
} from './run-definition.js';

export interface LoadedRunEvents {
  readonly stream: EventStreamRef;
  readonly events: readonly DomainEventEnvelope[];
}

export type RunEventAppendCheck = (
  events: readonly DomainEventEnvelope[],
) => 'append' | 'already-stored';

export async function readRunEvents(
  storage: RunStorageBinding,
  runId: string,
): Promise<LoadedRunEvents> {
  await loadRunDefinition(storage, runId);
  const stream = { namespace: storage.record.namespace, streamId: runId };
  const events: DomainEventEnvelope[] = [];
  for await (const event of storage.eventStore.read(stream)) events.push(event);
  return Object.freeze({ stream, events: Object.freeze(events) });
}

export async function appendRunEvent(
  storage: RunStorageBinding,
  runId: string,
  event: NewDomainEvent,
  check?: RunEventAppendCheck,
): Promise<void> {
  const safe = validateNewDomainEvent(event);
  for (;;) {
    const loaded = await readRunEvents(storage, runId);
    if (check?.(loaded.events) === 'already-stored') return;
    const revision = loaded.events.at(-1)?.revision ?? 0;
    try {
      await storage.eventStore.append(
        loaded.stream,
        revision,
        [safe] as DomainEventBatch,
      );
      return;
    } catch (error) {
      if (error instanceof StorageError && error.code === 'REVISION_CONFLICT') continue;
      throw error;
    }
  }
}
