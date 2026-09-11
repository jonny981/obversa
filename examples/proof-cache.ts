import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  compileGraph,
  createAcceptedResultRecord,
  createGitWorktreeProvider,
  createGraphExecutor,
  createProofCache,
  dagGraphType,
  persistRunDefinition,
  resolveGraphPlan,
  type GraphNodeBinding,
  type ProofSource,
  type Sha256Digest,
} from '@obversa/runtime';
import { createLocalRunStorage } from '@obversa/runtime/storage/local';

const git = promisify(execFile);
const directory = await realpath(await mkdtemp(join(tmpdir(), 'obversa-proof-cache-')));

try {
  const repository = join(directory, 'repository');
  await mkdir(repository);
  await git('git', ['init', '-q', '-b', 'main'], { cwd: repository });
  await writeFile(join(repository, 'README.md'), '# Proof cache example\n');
  await git('git', ['add', 'README.md'], { cwd: repository });
  await git('git', [
    '-c', 'user.name=Example', '-c', 'user.email=example@example.com',
    'commit', '-qm', 'initial',
  ], { cwd: repository });
  const workspace = createGitWorktreeProvider({ repositoryPath: repository });
  const workspaceAnchor = await workspace.capture();
  assert.equal((await workspace.verify(workspaceAnchor)).ok, true);

  const graph = compileGraph(dagGraphType, {
    id: 'cached-proof',
    definitionVersion: 1,
    data: {
      globalConcurrency: 1,
      keyedConcurrency: {},
      stopOnError: true,
      retryCapPerNode: 0,
    },
    nodes: [{ id: 'review', data: { kind: 'required', key: null } }],
    edges: [],
  });
  const packageIdentity = {
    source: 'npm:@example/cached-proof',
    version: '1.0.0',
    digest: `sha256:${'7'.repeat(64)}` as Sha256Digest,
  };
  const plan = resolveGraphPlan(graph.describe(), {
    package: packageIdentity,
    admission: { package: packageIdentity, permissions: [] },
    executionLanes: [],
  });
  const runId = 'cached-proof-run';
  const storage = createLocalRunStorage({
    directory: join(directory, 'storage'),
    namespace: 'proof-cache-example',
    policy: {
      schemaVersion: 1,
      maxEventPayloadBytes: 64_000,
      maxAppendBatchBytes: 128_000,
      maxArtifactBytes: 1_000_000,
      maxTotalArtifactBytesPerRun: 4_000_000,
      retention: 'until-run-delete',
      sensitiveContent: { marked: 'reject', exact: 'reject', freeText: 'redact-before-hash' },
    },
  });
  await persistRunDefinition(storage, {
    runId,
    eventId: 'cached-proof-started',
    timestamp: '2026-01-01T00:00:00.000Z',
    graphDefinition: graph.definition,
    resolvedPlan: plan,
    resolvedInputs: {},
    workspaceBinding: null,
    hostBinding: null,
  });

  // These in-memory sources own their revisions; every payload edit advances it.
  const config = { revision: '1', content: 'timeoutMs: 1000' };
  const policy = { revision: '1', content: 'A timeout must be positive.' };
  const sourceReads = { config: 0, policy: 0 };
  const sources: ProofSource[] = Object.entries({ config, policy }).map(([id, source]) => ({
    id,
    revision: async () => source.revision,
    read: async (expectedRevision, maxBytes) => {
      assert.equal(source.revision, expectedRevision);
      assert.ok(Buffer.byteLength(JSON.stringify(source.content)) <= maxBytes);
      sourceReads[id as keyof typeof sourceReads] += 1;
      return source.content;
    },
  }));
  const cache = createProofCache({
    storage,
    runId,
    sources,
    maxPacketBytes: 16_000,
    proofJobs: [
      { id: 'review', mode: 'read-only', sourceIds: ['config', 'policy'], proofScope: { kind: 'config-review' } },
      { id: 'policy', mode: 'read-only', sourceIds: ['policy'], proofScope: { kind: 'policy-review' } },
      { id: 'apply', mode: 'effectful', sourceIds: ['config'], proofScope: { kind: 'write' } },
    ],
  });
  const [first, second, policyPacket] = await Promise.all([
    cache.packet('review'), cache.packet('review'), cache.packet('policy'),
  ]);
  let proofRuns = 0;
  const result = { verdict: 'pass', proof: first.proofArtifact.digest };
  const node: GraphNodeBinding = {
    prompt: null,
    scratchDirectory: directory,
    workspace: { mode: 'none', directory: null, allowedPaths: [] },
    trustedCaller: {},
    permissions: [],
    policy: {
      inputBytes: 100_000, outputBytes: 100_000, timeoutMs: 5_000,
      teardownGraceMs: 100, memoryBytes: 100_000_000,
      filesChanged: 0, linesChanged: 0, callTokens: null,
    },
    resultContract: null,
    runData: async () => {
      proofRuns += 1;
      const captured = first.packet.sources.find((source) => source.id === 'config');
      const timeout = typeof captured?.content === 'string'
        ? /^timeoutMs: ([0-9]+)$/.exec(captured.content)
        : null;
      assert.ok(timeout && Number(timeout[1]) > 0, 'The captured config needs a positive timeout.');
      return result;
    },
    parseResult: null,
    tokenBudget: null,
    decideAction: async () => ({ kind: 'allow' }),
  };
  const executor = await createGraphExecutor({ runId, graph, storage, nodes: { review: node }, engines: [] });
  assert.equal((await executor.run(new AbortController().signal)).kind, 'complete');
  const dispatch = graph.decide(graph.initialState()).find((command) => command.kind === 'dispatch');
  assert.ok(dispatch?.kind === 'dispatch');
  const current = {
    graph: { definitionDigest: plan.plan.graph.definitionDigest, typeVersion: plan.plan.graph.typeVersion },
    workspaceAnchor,
    reviewerIdentity: { id: 'scripted-timeout-review', version: 1 },
  };
  await createAcceptedResultRecord(storage, runId, dispatch.position, {
    ...current,
    inputHashes: first.inputHashes,
    proofArtifact: first.proofArtifact,
    proofScope: first.proofScope,
    result,
  });
  assert.equal((await workspace.verify(workspaceAnchor)).ok, true);
  const reused = await cache.resolveAccepted('review', dispatch.position, current);
  assert.equal(reused.kind, 'accepted');
  if (reused.kind === 'accepted') assert.deepEqual(reused.record.result, result);
  const changedReviewer = await cache.resolveAccepted('review', dispatch.position, {
    ...current, reviewerIdentity: { id: 'different-reviewer', version: 1 },
  });
  config.content = 'timeoutMs: 2000';
  config.revision = '2';
  const changedSource = await cache.resolveAccepted('review', dispatch.position, current);
  const unchangedPolicy = await cache.packet('policy');
  await assert.rejects(async () => cache.packet('apply'));

  console.log(JSON.stringify({
    sourceReads,
    proofRuns,
    sharedPacket: first.proofArtifact.digest === second.proofArtifact.digest,
    reused: reused.kind,
    changedSource: changedSource.kind,
    unaffectedPacket: policyPacket.proofArtifact.digest === unchangedPolicy.proofArtifact.digest,
    changedReviewer: changedReviewer.kind,
    effectfulRefused: true,
  }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
