import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAcceptedResultRecord } from '../src/proof/acceptance.js';
import { writeProofArtifact } from '../src/proof/artifact.js';
import type { Sha256Digest } from '../src/graph/value.js';
import { loadRunDefinition } from '../src/runtime/run-definition.js';
import type { WorkspaceAnchor } from '../src/workspace/provider.js';
import {
  createStoredRunFixture,
  recordFixtureDispatches,
  recordFixtureCompletions,
  type StoredRunFixture,
} from './stored-run-fixture.js';

// Real work: these tests write files to temporary directories on disk, so
// this file declares its own time limit; the suite default is a hang guard,
// not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const hash = (digit: string): Sha256Digest => `sha256:${digit.repeat(64)}` as Sha256Digest;

const workspaceAnchor: WorkspaceAnchor = {
  schemaVersion: 1,
  root: '/repo',
  repositoryId: '/repo/.git',
  head: 'a'.repeat(40),
  fingerprint: 'b'.repeat(64),
  scope: null,
  files: [],
};

let run: StoredRunFixture;

beforeEach(async () => {
  run = await createStoredRunFixture('proof-artifact');
});

afterEach(async () => {
  await run.close();
});

describe('proof artifact', () => {
  it('two accepted-result records cite the same proof artifact hash', async () => {
    const scope = { namespace: run.storage.record.namespace, runId: run.runId };
    const proofArtifact = await writeProofArtifact(run.storage.artifactStore, scope, {
      result: { passed: true, count: 21 },
      inputs: { source: hash('1') },
    });
    const stored = await loadRunDefinition(run.storage, run.runId);
    const common = {
      result: { verdict: 'pass' },
      inputHashes: { source: hash('1') },
      proofScope: { kind: 'review', paths: ['packages/runtime'] },
      proofArtifact,
      graph: {
        definitionDigest: stored.resolvedPlan.plan.graph.definitionDigest,
        typeVersion: stored.resolvedPlan.plan.graph.typeVersion,
      },
      workspaceAnchor,
    } as const;
    const {
      reviewA: firstPosition,
      reviewB: secondPosition,
    } = await recordFixtureDispatches(run);
    await recordFixtureCompletions(run, { reviewA: common.result, reviewB: common.result });
    const first = await createAcceptedResultRecord(run.storage, run.runId, firstPosition, {
      ...common,
      reviewerIdentity: { provider: 'anthropic', model: 'claude' },
    });
    const second = await createAcceptedResultRecord(run.storage, run.runId, secondPosition, {
      ...common,
      reviewerIdentity: { provider: 'openai', model: 'gpt' },
    });

    expect(first.binding.proofArtifact.digest).toBe(proofArtifact.digest);
    expect(second.binding.proofArtifact.digest).toBe(proofArtifact.digest);
    expect(first.binding.reviewerFingerprint).not.toBe(second.binding.reviewerFingerprint);

    const reordered = await writeProofArtifact(run.storage.artifactStore, scope, {
      inputs: { source: hash('1') },
      result: { count: 21, passed: true },
    });
    expect(reordered).toEqual(proofArtifact);

    const changed = await writeProofArtifact(run.storage.artifactStore, scope, {
      result: { passed: true, count: 22 },
      inputs: { source: hash('1') },
    });
    expect(changed.digest).not.toBe(proofArtifact.digest);
  });
});
