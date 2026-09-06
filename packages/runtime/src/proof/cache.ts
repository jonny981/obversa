import {
  canonicalJson,
  cloneFrozenJson,
  digestJson,
  type JsonObject,
  type JsonValue,
  type Sha256Digest,
} from '../graph/value.js';
import type { RunStorageBinding } from '../runtime/run-definition.js';
import { writeProofArtifact, type ProofArtifactReference } from './artifact.js';

/** Read-only sources must change their revision on every change, without reusing old revisions. */
export interface ProofSource {
  readonly id: string;
  revision(): Promise<string>;
  /** Return the full JSON value at this revision, bounded by its encoded UTF-8 size. */
  read(expectedRevision: string, maxBytes: number): Promise<JsonValue>;
}

export interface ProofJob {
  readonly id: string;
  readonly mode: 'read-only' | 'effectful';
  readonly sourceIds: readonly string[];
  readonly proofScope: JsonObject;
}

export interface ProofPacketSource extends JsonObject {
  readonly id: string;
  readonly revision: string;
  readonly digest: Sha256Digest;
  readonly content: JsonValue;
}

export interface ProofPacket extends JsonObject {
  readonly schemaVersion: 1;
  readonly sources: readonly ProofPacketSource[];
}

export interface CachedProofPacket {
  readonly packet: ProofPacket;
  readonly inputHashes: Readonly<Record<string, Sha256Digest>>;
  readonly proofArtifact: ProofArtifactReference;
  readonly proofScope: JsonObject;
}

export interface ProofCacheOptions {
  readonly storage: RunStorageBinding;
  readonly runId: string;
  readonly sources: readonly ProofSource[];
  readonly proofJobs: readonly ProofJob[];
  readonly maxPacketBytes: number;
}

export interface ProofCache {
  packet(jobId: string): Promise<CachedProofPacket>;
}

function identifier(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError('proof cache identifiers must be non-empty trimmed strings without control characters');
  }
}

/** One host process and stored run; source adapters own revision authority and read-only behavior. */
export function createProofCache(options: ProofCacheOptions): ProofCache {
  const { storage, runId, maxPacketBytes } = options;
  identifier(runId);
  if (!Number.isSafeInteger(maxPacketBytes) || maxPacketBytes < 1) {
    throw new TypeError('maxPacketBytes must be a positive safe integer');
  }
  const sources = new Map<string, ProofSource>();
  for (const source of options.sources) {
    identifier(source.id);
    if (sources.has(source.id)) throw new TypeError(`duplicate source: ${source.id}`);
    sources.set(source.id, Object.freeze({
      id: source.id, revision: source.revision.bind(source), read: source.read.bind(source),
    }));
  }
  const jobs = new Map<string, ProofJob>();
  for (const job of options.proofJobs) {
    identifier(job.id);
    if (jobs.has(job.id)) throw new TypeError(`duplicate proof job: ${job.id}`);
    if (job.mode !== 'read-only' && job.mode !== 'effectful') throw new TypeError('invalid proof job mode');
    if (new Set(job.sourceIds).size !== job.sourceIds.length) throw new TypeError(`duplicate source in proof job: ${job.id}`);
    for (const id of job.sourceIds) {
      if (!sources.has(id)) throw new TypeError(`unknown source: ${id}`);
    }
    if (job.proofScope === null || typeof job.proofScope !== 'object' || Array.isArray(job.proofScope)) {
      throw new TypeError('proofScope must be an object');
    }
    jobs.set(job.id, cloneFrozenJson({
      id: job.id, mode: job.mode, sourceIds: [...job.sourceIds].sort(), proofScope: job.proofScope,
    }) as unknown as ProofJob);
  }

  const captured = new Map<string, { revision: string; value: Promise<ProofPacketSource> }>();
  const packets = new Map<string, { key: string; value: Promise<CachedProofPacket> }>();
  const scope = Object.freeze({ namespace: storage.record.namespace, runId });

  async function revision(source: ProofSource): Promise<string> {
    const value = await source.revision();
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`invalid source revision: ${source.id}`);
    return value;
  }

  function capture(source: ProofSource, expected: string): Promise<ProofPacketSource> {
    const previous = captured.get(source.id);
    if (previous?.revision === expected) return previous.value;
    const entry = {
      revision: expected,
      value: Promise.resolve().then(async () => {
        const content = cloneFrozenJson(await source.read(expected, maxPacketBytes));
        if (Buffer.byteLength(canonicalJson(content), 'utf8') > maxPacketBytes) {
          throw new RangeError('proof source exceeds maxPacketBytes');
        }
        if (await revision(source) !== expected || captured.get(source.id) !== entry) {
          throw new Error(`proof source revision changed: ${source.id}`);
        }
        return cloneFrozenJson({ id: source.id, revision: expected, digest: digestJson(content), content }) as ProofPacketSource;
      }).catch((error: unknown) => {
        if (captured.get(source.id) === entry) captured.delete(source.id);
        throw error;
      }),
    };
    captured.set(source.id, entry);
    return entry.value;
  }

  async function packet(jobId: string): Promise<CachedProofPacket> {
    const job = jobs.get(jobId);
    if (job === undefined) throw new TypeError(`unknown proof job: ${jobId}`);
    if (job.mode !== 'read-only') throw new TypeError(`proof job must be read-only: ${jobId}`);
    const selected = job.sourceIds.map((id) => sources.get(id)!);
    const observed = selected.map((source) => captured.get(source.id));
    const revisions = await Promise.all(selected.map(revision));
    if (selected.some((source, index) => {
      const current = captured.get(source.id);
      return current !== observed[index] && current !== undefined && current.revision !== revisions[index];
    })) throw new Error(`proof source revision changed during revision lookup: ${jobId}`);
    const key = canonicalJson(revisions);
    const previous = packets.get(jobId);
    if (previous?.key === key) return previous.value;
    const entry = {
      key,
      value: Promise.resolve().then(async () => {
        const values = await Promise.all(selected.map((source, index) => capture(source, revisions[index]!)));
        const proof = cloneFrozenJson({ schemaVersion: 1, sources: values }) as ProofPacket;
        if (Buffer.byteLength(canonicalJson(proof), 'utf8') > maxPacketBytes) {
          throw new RangeError('proof packet exceeds maxPacketBytes');
        }
        const proofArtifact = await writeProofArtifact(storage.artifactStore, scope, proof);
        if (canonicalJson(await Promise.all(selected.map(revision))) !== key || packets.get(jobId) !== entry) {
          throw new Error(`proof source revision changed during packet capture: ${jobId}`);
        }
        return cloneFrozenJson({
          packet: proof, inputHashes: Object.fromEntries(values.map((value) => [value.id, value.digest])),
          proofArtifact, proofScope: job.proofScope,
        }) as unknown as CachedProofPacket;
      }).catch((error: unknown) => {
        if (packets.get(jobId) === entry) packets.delete(jobId);
        throw error;
      }),
    };
    packets.set(jobId, entry);
    return entry.value;
  }

  return Object.freeze({ packet });
}
