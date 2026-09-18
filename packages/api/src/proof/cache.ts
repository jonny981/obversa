import type { JsonObject, JsonValue, Sha256Digest } from '../json.js';
import type { RunStorageBinding } from '../run-definition.js';
import type { AcceptedResultBindingInput, AcceptedResultResolution } from './acceptance.js';
import type { ProofArtifactReference } from './artifact.js';

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
  resolveAccepted(
    jobId: string,
    position: string,
    current: ProofCacheCurrentBinding,
  ): Promise<AcceptedResultResolution>;
}

/** The host supplies the current graph, verified workspace anchor and reviewer identity. */
export type ProofCacheCurrentBinding = Omit<
  AcceptedResultBindingInput,
  'inputHashes' | 'proofScope' | 'proofArtifact'
>;
