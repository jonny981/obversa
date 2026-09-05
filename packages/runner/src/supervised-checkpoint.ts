import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { DomainEventEnvelope } from '@obversa/runtime';
import { cloneFrozenJson, digestJson, type JsonObject, type Sha256Digest } from '@obversa/engine';

interface ActiveOccurrence extends JsonObject {
  readonly nodeId: string;
  readonly position: string;
  readonly startedAt: string;
}

interface SupervisedEventState extends JsonObject {
  readonly active: readonly ActiveOccurrence[];
  readonly paused: Readonly<Record<string, string>>;
}

export interface SupervisedCheckpoint extends JsonObject {
  readonly schemaVersion: 1;
  readonly namespace: string;
  readonly streamId: string;
  readonly revision: number;
  readonly lastEventId: string;
  readonly state: SupervisedEventState;
  readonly digest: Sha256Digest;
}

function validState(state: unknown): state is SupervisedEventState {
  if (state === null || typeof state !== 'object') return false;
  const value = state as SupervisedEventState;
  return Array.isArray(value.active) && value.active.every((item) => (
    item !== null && typeof item === 'object' && typeof item.nodeId === 'string'
    && typeof item.position === 'string' && typeof item.startedAt === 'string'
    && Number.isFinite(Date.parse(item.startedAt))
  )) && value.paused !== null && typeof value.paused === 'object' && !Array.isArray(value.paused)
    && Object.values(value.paused).every((reason) => typeof reason === 'string');
}

/** Checkpoints summarize display state only; executor decisions always fold events. */
export function foldSupervisedEvents(
  namespace: string,
  events: readonly DomainEventEnvelope[],
  candidate?: unknown,
): { readonly state: SupervisedEventState; readonly checkpoint: SupervisedCheckpoint; readonly reused: boolean } {
  const last = events.at(-1);
  if (candidate !== null && typeof candidate === 'object' && last !== undefined) {
    const checkpoint = candidate as SupervisedCheckpoint;
    try {
      if (checkpoint.schemaVersion === 1 && checkpoint.namespace === namespace
        && checkpoint.streamId === last.streamId && checkpoint.revision === last.revision
        && checkpoint.lastEventId === last.eventId && validState(checkpoint.state)
        && checkpoint.digest === digestJson(checkpoint.state)) {
        const frozen = cloneFrozenJson(checkpoint);
        return { state: frozen.state, checkpoint: frozen, reused: true };
      }
    } catch { /* Malformed cache data has no authority over events. */ }
  }
  const active = new Map<string, ActiveOccurrence>();
  const paused: Record<string, string> = {};
  for (const event of events) {
    const payload = event.payload as JsonObject;
    if (event.type === 'graph:node-dispatched' || event.type === 'graph:node-resumed') {
      const position = String(payload.position);
      active.set(position, { nodeId: String(payload.nodeId), position, startedAt: event.timestamp });
      delete paused[position];
    } else if (event.type === 'graph:node-attempt-started') {
      const identity = payload.identity as JsonObject;
      const position = String(identity.position);
      if (active.has(position)) active.set(position, { nodeId: String(identity.nodeId), position, startedAt: event.timestamp });
    } else if (['graph:node-completed', 'graph:node-failed', 'graph:node-paused'].includes(event.type)) {
      const position = String(payload.position);
      active.delete(position);
      delete paused[position];
      if (event.type === 'graph:node-paused') paused[position] = String(payload.reason);
    }
  }
  const state = cloneFrozenJson({ active: [...active.values()], paused });
  const checkpoint: SupervisedCheckpoint = {
    schemaVersion: 1, namespace, streamId: last?.streamId ?? '', revision: last?.revision ?? 0,
    lastEventId: last?.eventId ?? '', state, digest: digestJson(state),
  };
  return { state, checkpoint, reused: false };
}

export async function localSupervisedCheckpoint(
  directory: string,
  namespace: string,
  events: readonly DomainEventEnvelope[],
): Promise<SupervisedEventState> {
  const cacheDirectory = join(resolve(directory), 'runner-checkpoints');
  const path = join(cacheDirectory, `${digestJson({ namespace, streamId: events.at(-1)?.streamId ?? '' }).slice(7)}.json`);
  let candidate: unknown;
  try {
    if ((await lstat(cacheDirectory)).isDirectory() && (await lstat(path)).isFile()) {
      candidate = JSON.parse(await readFile(path, 'utf8'));
    }
  } catch { /* Missing or unreadable cache: fold the events. */ }
  const folded = foldSupervisedEvents(namespace, events, candidate);
  if (!folded.reused) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(cacheDirectory, { recursive: true });
      if (!(await lstat(cacheDirectory)).isDirectory()) return folded.state;
      await writeFile(temporary, JSON.stringify(folded.checkpoint), { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } catch { /* A cache write failure cannot stop a readable run. */ }
    finally { await unlink(temporary).catch(() => {}); }
  }
  return folded.state;
}
