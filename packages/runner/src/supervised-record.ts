import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { CommandCleanupCapability } from '@obversa/engine/command';

import type { DomainEventEnvelope, JsonObject, Sha256Digest, RunStorageBinding } from '@obversa/runtime';

export class SupervisedRunError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SupervisedRunError';
  }
}

export interface SupervisedHostRecord extends JsonObject {
  readonly schemaVersion: 1;
  readonly module: string;
  readonly digest: Sha256Digest;
  readonly cleanupCapability: CommandCleanupCapability;
  readonly limits: { readonly timeoutMs: number; readonly maxDispatches: number };
}

export function supervisionStream(runId: string): string {
  return `runner-${createHash('sha256').update(runId).digest('hex')}`;
}

export async function readSupervision(
  storage: RunStorageBinding,
  runId: string,
): Promise<readonly DomainEventEnvelope[]> {
  const events: DomainEventEnvelope[] = [];
  for await (const event of storage.eventStore.read({
    namespace: storage.record.namespace,
    streamId: supervisionStream(runId),
  })) events.push(event);
  return events;
}

/** Settled pauses freeze the execution budget until a stored worker launch. */
export function supervisedElapsedMs(
  startedAt: string,
  records: readonly Pick<DomainEventEnvelope, 'type' | 'timestamp'>[],
  end: number,
): number {
  let runningSince: number | undefined = Date.parse(startedAt);
  let elapsed = 0;
  for (const record of records) {
    if (record.type === 'runner:worker-launching' && runningSince === undefined) {
      runningSince = Date.parse(record.timestamp);
    } else if (runningSince !== undefined && [
      'runner:paused', 'runner:completed', 'runner:failed', 'runner:stopped', 'runner:timeout', 'runner:budget-stop',
    ].includes(record.type)) {
      elapsed += Math.max(0, Date.parse(record.timestamp) - runningSince);
      runningSince = undefined;
    }
  }
  return elapsed + (runningSince === undefined ? 0 : Math.max(0, end - runningSince));
}

/** Read lifecycle state without treating proof or callback evidence as a transition. */
export async function readGraphPosition(storage: RunStorageBinding, runId: string, position: string) {
  let last: DomainEventEnvelope | undefined;
  for await (const event of storage.eventStore.read({ namespace: storage.record.namespace, streamId: runId })) {
    if (['graph:node-dispatched', 'graph:node-paused', 'graph:node-resumed', 'graph:node-completed', 'graph:node-failed'].includes(event.type)
      && (event.payload as JsonObject).position === position) last = event;
  }
  return last;
}

/** The watchdog writes only while no worker is running. */
export function supervisionWriter(storage: RunStorageBinding, runId: string) {
  let tail: Promise<void> = Promise.resolve();
  return (type: string, payload: JsonObject): Promise<void> => {
    const next = tail.then(async () => {
      const events = await readSupervision(storage, runId);
      await storage.eventStore.append({
        namespace: storage.record.namespace,
        streamId: supervisionStream(runId),
      }, events.at(-1)?.revision ?? 0, [{
        eventId: randomUUID(), type: `runner:${type}`, version: 1,
        timestamp: new Date().toISOString(), correlationId: runId,
        causationId: null, payload,
      }]);
    });
    tail = next.catch(() => {});
    return next;
  };
}

export function resolveHostModule(runRoot: string, specifier: string): string {
  if (isAbsolute(specifier) || !/^\.\.?\//u.test(specifier)) {
    throw new SupervisedRunError('HOST_MODULE', 'The host module must be a relative file specifier.');
  }
  const lexicalRoot = resolve(runRoot);
  const lexicalModule = resolve(lexicalRoot, specifier);
  const lexicalRelative = relative(lexicalRoot, lexicalModule);
  if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) {
    throw new SupervisedRunError('HOST_MODULE', 'The host module must be inside the run root.');
  }
  const realRoot = realpathSync(lexicalRoot);
  let realModule: string;
  try {
    realModule = realpathSync(lexicalModule);
  } catch (cause) {
    throw new SupervisedRunError('HOST_MODULE', 'The host module path could not be resolved.', { cause });
  }
  const realRelative = relative(realRoot, realModule);
  if (realRelative === '..' || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
    throw new SupervisedRunError('HOST_MODULE', 'The host module must be inside the run root.');
  }
  return realModule;
}

export async function hostModuleDigest(path: string): Promise<Sha256Digest> {
  return `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`;
}
