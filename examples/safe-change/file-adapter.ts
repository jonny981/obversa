import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { EventStreamRef, JsonObject, Sha256Digest } from '@obversa/runtime';

export type SourceKind = 'document' | 'current-record' | 'discussion-comment' | 'historical-entry';
export interface SourceRecord extends JsonObject {
  readonly id: string;
  readonly kind: SourceKind;
  readonly metadata: JsonObject;
  readonly body: string;
}
export interface ActionWitness extends JsonObject {
  readonly actionId: string;
  readonly proposalDigest: Sha256Digest;
  readonly beforeDigest: Sha256Digest;
  readonly afterDigest: Sha256Digest;
}
export interface TargetRecord extends JsonObject {
  readonly id: string;
  readonly revision: number;
  readonly active: boolean;
  readonly content: string;
  readonly lastAction: ActionWitness | null;
}
export interface SafeChangeInput extends JsonObject {
  readonly sourceIds: readonly string[];
  readonly destinations: readonly { readonly id: string; readonly expectedRevision: number; readonly content: string }[];
  readonly mappings: readonly { readonly sourceId: string; readonly targetId: string }[];
}
export interface SafeChangeHooks {
  readonly afterTargetWrite?: (actionId: string, targetId: string) => Promise<void>;
}

function id(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new TypeError('Invalid safe-change record ID');
  return value;
}
export const sourcePath = (directory: string, value: string): string => join(directory, 'sources', `${id(value)}.json`);
export const targetPath = (directory: string, value: string): string => join(directory, 'targets', `${id(value)}.json`);
export const sourceStream = (value: string): EventStreamRef => ({ namespace: 'safe-change', streamId: `source-${id(value)}` });
export const targetStream = (value: string): EventStreamRef => ({ namespace: 'safe-change', streamId: `target-${id(value)}` });
export const hashBytes = (bytes: string | Uint8Array): Sha256Digest => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export async function readRecordBuffer(path: string): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 64 * 1024) throw new Error('Safe-change requires a regular record of at most 64 KiB');
  const bytes = await readFile(path);
  if (bytes.byteLength > 64 * 1024) throw new Error('Safe-change record exceeds 64 KiB');
  return bytes;
}
export const readRecordBytes = async (path: string): Promise<string> => new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(await readRecordBuffer(path));
export const readSource = async (directory: string, value: string): Promise<SourceRecord> => JSON.parse(await readRecordBytes(sourcePath(directory, value))) as SourceRecord;
export async function readTarget(directory: string, value: string): Promise<TargetRecord> {
  const record: unknown = JSON.parse(await readRecordBytes(targetPath(directory, value)));
  if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid target record');
  const target = record as TargetRecord;
  if (target.id !== value || !Number.isSafeInteger(target.revision) || target.revision < 1
    || typeof target.active !== 'boolean' || typeof target.content !== 'string') throw new Error(`Invalid target identity or state for ${value}`);
  const witness = target.lastAction;
  if (witness !== null && (typeof witness !== 'object' || Array.isArray(witness) || !witness
    || typeof witness.actionId !== 'string' || witness.actionId.length === 0
    || ![witness.beforeDigest, witness.afterDigest, witness.proposalDigest].every((digest) => typeof digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(digest)))) {
    throw new Error(`Invalid action witness for ${value}`);
  }
  return target;
}

/** The replacement happened, but its durable response or hook did not finish. */
export class TargetWriteUncertain extends Error {}

/** One writer owns this synthetic directory; content, revision and witness share one rename. */
export async function replaceTarget(directory: string, value: TargetRecord): Promise<void> {
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > 64 * 1024) throw new Error('Safe-change serialized target exceeds 64 KiB');
  const path = targetPath(directory, value.id);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally { await file.close(); }
  await rename(temporary, path);
  try {
    const folder = await open(dirname(path), 'r');
    try { await folder.sync(); } finally { await folder.close(); }
  } catch (cause) { throw new TargetWriteUncertain('Target replacement requires readback', { cause }); }
}

export async function applyTarget(
  directory: string,
  destination: SafeChangeInput['destinations'][number],
  witness: ActionWitness,
  recheck: () => Promise<void>,
  hooks: SafeChangeHooks,
): Promise<void> {
  await recheck();
  const before = await readTarget(directory, destination.id);
  if (!before.active) throw new Error(`Destination ${destination.id} is inactive`);
  if (before.revision !== destination.expectedRevision) throw new Error(`Target ${destination.id} version changed`);
  if (hashBytes(await readRecordBytes(targetPath(directory, destination.id))) !== witness.beforeDigest) throw new Error(`Target ${destination.id} bytes changed`);
  if (hashBytes(destination.content) !== witness.afterDigest) throw new Error('Proposed output differs from the approved action');
  await replaceTarget(directory, {
    ...before, revision: before.revision + 1, content: destination.content, lastAction: witness,
  });
  try { await hooks.afterTargetWrite?.(witness.actionId, destination.id); }
  catch (cause) { throw new TargetWriteUncertain('Target response was lost after replacement', { cause }); }
}

export async function seedSafeChangeFixture(directory: string): Promise<SafeChangeInput> {
  await mkdir(join(directory, 'sources'), { recursive: true });
  const kinds: SourceKind[] = ['document', 'current-record', 'discussion-comment', 'historical-entry'];
  const sources: SourceRecord[] = kinds.map((kind, index) => ({
    id: `source-${index + 1}`, kind,
    metadata: { author: `fixture-${index + 1}`, revision: 1, historical: kind === 'historical-entry' },
    body: `# ${kind}\n\nProtected: café — “quoted”; punctuation!\n\n\`\`\`ts\nconst value = "${index}";\n\`\`\`\n`,
  }));
  for (const source of sources) {
    const file = await open(sourcePath(directory, source.id), 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(source)); } finally { await file.close(); }
  }
  const destinations = ['target-one', 'target-two'].map((target, index) => ({
    id: target, expectedRevision: 1, content: JSON.stringify(sources.slice(index * 2, index * 2 + 2)),
  }));
  for (const destination of destinations) await replaceTarget(directory, {
    id: destination.id, revision: 1, active: true, content: '[]', lastAction: null,
  });
  return { sourceIds: sources.map((source) => source.id), destinations,
    mappings: sources.map((source, index) => ({ sourceId: source.id, targetId: destinations[Math.floor(index / 2)]!.id })) };
}
