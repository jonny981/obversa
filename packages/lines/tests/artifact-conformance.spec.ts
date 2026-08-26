import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertArtifactStoreConformance,
  runArtifactStoreConformance,
} from '../src/artifacts/conformance.js';
import { createLocalArtifactStore } from '../src/artifacts/file-store.js';
import type { ArtifactStore } from '../src/artifacts/store.js';

const roots: string[] = [];

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'obversa-artifacts-'));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe('artifact-store conformance', () => {
  it('passes the local provider through the public framework-free kit', async () => {
    const directory = await root();
    const factory = (options: {
      readonly maxArtifactBytes: number;
      readonly maxTotalArtifactBytesPerRun: number;
      readonly knownSecrets: readonly string[];
    }) => createLocalArtifactStore({ root: directory, ...options });

    const report = await runArtifactStoreConformance(factory);

    expect(report.ok).toBe(true);
    expect(report.cases).toBe(15);
    expect(report.failures).toEqual([]);
    await expect(assertArtifactStoreConformance(factory)).resolves.toBeUndefined();
  });

  it('reports a provider that returns forged references', async () => {
    const broken: ArtifactStore = {
      async preflightWrite() {
        return [];
      },
      async write() {
        return {
          schemaVersion: 1,
          digest: `sha256:${'0'.repeat(64)}`,
          byteLength: 0,
          mediaType: 'application/octet-stream',
          purpose: 'wrong',
        };
      },
      async read() {
        return new Uint8Array();
      },
      async deleteRun() {},
    };

    const report = await runArtifactStoreConformance(() => broken);

    expect(report.ok).toBe(false);
    expect(report.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ case: 'fresh-provider durable read' }),
      expect.objectContaining({ case: 'forged exact receipt rejection' }),
      expect.objectContaining({ case: 'two-provider final-capacity race' }),
      expect.objectContaining({
        case: expect.any(String),
        message: expect.any(String),
      }),
    ]));
    await expect(assertArtifactStoreConformance(() => broken)).rejects.toThrow(
      /artifact store conformance failed/i,
    );
  });

  it('reports a provider that does not pin committed numeric limits', async () => {
    const directory = await root();
    const factory = () => createLocalArtifactStore({
      root: directory,
      maxArtifactBytes: 64,
      maxTotalArtifactBytesPerRun: 128,
      knownSecrets: ['known-secret-value'],
    });

    const report = await runArtifactStoreConformance(factory);

    expect(report.failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ case: 'restart policy identity' }),
    ]));
  });
});
