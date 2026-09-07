import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactReference, JsonObject } from '@obversa/runtime';
import { openSafeChangeRun } from './recipe.js';
import { readRecordBytes, readSource, readTarget, seedSafeChangeFixture, sourcePath, targetPath, targetStream } from './file-adapter.js';

const directory = await mkdtemp(join(tmpdir(), 'obversa-safe-change-'));
let report;
try {
  const input = await seedSafeChangeFixture(directory);
  const original = {
    sources: await Promise.all(input.sourceIds.map(async (id) => ({ id, bytes: await readRecordBytes(sourcePath(directory, id)) }))),
    targets: await Promise.all(input.destinations.map(async ({ id }) => ({ id, bytes: await readRecordBytes(targetPath(directory, id)) }))),
  };
  const run = await openSafeChangeRun({ directory, runId: 'safe-change-example', input });
  const signal = new AbortController().signal;
  assert.equal((await run.executor.run(signal)).kind, 'pause');
  // This runnable fixture uses scripted approval, not a model or human review.
  await run.approve();
  const result = await run.executor.resume(run.approvalPosition, signal);
  assert.equal(result.kind, 'complete');
  if (result.kind !== 'complete') throw new Error('Safe change did not complete');
  const results: JsonObject[] = [];
  for (const target of input.destinations) {
    for await (const event of run.storage.eventStore.read(targetStream(target.id))) {
      if (event.type === 'safe-change:result') results.push(event.payload as JsonObject);
    }
  }
  const backup = JSON.parse(new TextDecoder().decode(await run.storage.artifactStore.read(
    { namespace: run.storage.record.namespace, runId: 'safe-change-example' }, results[0]!.backup as ArtifactReference,
  )));
  assert.deepEqual(backup, original);
  const targets = await Promise.all(input.destinations.map((target) => readTarget(directory, target.id)));
  const retention = ((result.output as JsonObject).nodes as JsonObject).retention as JsonObject;
  report = {
    status: result.kind,
    sourceKinds: await Promise.all(input.sourceIds.map(async (id) => (await readSource(directory, id)).kind)),
    sourceCount: input.sourceIds.length,
    actionCount: new Set(targets.map((target) => target.lastAction!.actionId)).size,
    protectedFacts: retention.protectedFacts,
    lostProtectedFacts: retention.lostProtectedFacts,
    targetResultCount: results.length,
    backupVerified: true,
    scriptedProposalAndReview: retention.scriptedProposalAndReview,
  };
} finally { await rm(directory, { recursive: true, force: true }); }
export const safeChangeReport = report;
console.log(JSON.stringify(safeChangeReport, null, 2));
