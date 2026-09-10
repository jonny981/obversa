import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// #region imports
import {
  compileGraph, createGraphExecutor, loadRunDefinition, persistRunDefinition,
  projectTeamRooms, resolveGraphPlan, teamGraphType,
  type DomainEventEnvelope, type GraphNodeBinding, type RunStoragePolicy,
  type TeamDefinition, type TeamGraphResult, type TeamMessage, type TeamTurnResult,
} from '@obversa/runtime';
import { createLocalRunStorage } from '@obversa/runtime/storage/local';
// #endregion imports

// #region definition
const definition: TeamDefinition = {
  id: 'release-team', definitionVersion: 1,
  data: {
    task: 'Prepare a release note.', globalConcurrency: 1, maxTurnsPerMember: 2,
    communication: { rooms: [{ id: 'review', members: ['writer', 'reviewer'] }], tailMessages: 3 },
  },
  nodes: [
    { id: 'writer', data: { role: 'writer', brief: 'Draft the release note.' } },
    { id: 'reviewer', data: { role: 'reviewer', brief: 'Check the draft.', initialTurn: false } },
  ],
  edges: [],
};
// #endregion definition

const storagePolicy = {
  schemaVersion: 1, maxEventPayloadBytes: 64_000, maxAppendBatchBytes: 128_000,
  maxArtifactBytes: 1_000_000, maxTotalArtifactBytesPerRun: 4_000_000,
  retention: 'until-run-delete',
  sensitiveContent: { marked: 'reject', exact: 'reject', freeText: 'redact-before-hash' },
} as const satisfies RunStoragePolicy;

function binding(directory: string, runData: NonNullable<GraphNodeBinding['runData']>): GraphNodeBinding {
  return {
    prompt: null, scratchDirectory: directory,
    workspace: { mode: 'none', directory: null, allowedPaths: [] },
    trustedCaller: {}, permissions: [],
    policy: {
      inputBytes: 10_000, outputBytes: 10_000, timeoutMs: 5_000,
      teardownGraceMs: 100, memoryBytes: 10_000_000,
      filesChanged: 0, linesChanged: 0, callTokens: null,
    },
    resultContract: null, runData, parseResult: null, tokenBudget: null,
    decideAction: async () => ({ kind: 'allow' }),
  };
}

const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'obversa-team-conversation-')));
const runId = 'release-team-run';
const openStorage = () => createLocalRunStorage({
  directory: join(temporaryRoot, 'storage'), namespace: 'team-conversation', policy: storagePolicy,
});
let report;
try {
  const storage = openStorage();
  const graph = compileGraph(teamGraphType, definition);
  const packageIdentity = {
    source: 'npm:@example/team-conversation', version: '1.0.0',
    digest: `sha256:${'3'.repeat(64)}` as const,
  };
  await persistRunDefinition(storage, {
    runId, eventId: 'release-team-started', timestamp: '2026-01-01T00:00:00.000Z',
    graphDefinition: graph.definition,
    resolvedPlan: resolveGraphPlan(graph.describe(), {
      package: packageIdentity, admission: { package: packageIdentity, permissions: [] }, executionLanes: [],
    }),
    resolvedInputs: {}, workspaceBinding: null, hostBinding: null,
  });
  for (const member of ['writer', 'reviewer']) await mkdir(join(temporaryRoot, member));
  type TurnInput = { task: string; result: TeamTurnResult | null; messages: TeamMessage[] };
  // #region posts
  const nodes = {
    writer: binding(join(temporaryRoot, 'writer'), async ({ input }): Promise<TeamTurnResult> => {
      const turn = input as TurnInput;
      if (turn.result === null) return {
        summary: 'Review requested.',
        posts: [{ roomId: 'review', text: `Please review: ${turn.task}`, mentions: ['reviewer'] }],
      };
      const reply = turn.messages.find((message) => message.sender === 'reviewer');
      assert.ok(reply, 'The writer requires the saved reviewer reply.');
      return { summary: `Finished ${turn.task}: ${reply.text}`, data: { replyId: reply.id, reply: reply.text } };
    }),
    reviewer: binding(join(temporaryRoot, 'reviewer'), async ({ input }) => {
      const question = (input as TurnInput).messages.find((message) => message.sender === 'writer');
      assert.ok(question, 'The reviewer requires the saved writer question.');
      return {
        summary: 'Draft checked.',
        posts: [{ roomId: question.roomId, text: `Reviewed ${question.id}: ${question.text}`, mentions: ['writer'] }],
      };
    }),
  };
  // #endregion posts
  const executor = await createGraphExecutor({ runId, graph, storage, nodes, engines: [] });
  const result = await executor.run(new AbortController().signal);
  assert.equal(result.kind, 'complete');
  if (result.kind !== 'complete') throw new Error('The conversation did not complete.');
  const output = result.output as TeamGraphResult;
  assert.equal(output.agents.find((agent) => agent.name === 'writer')?.result?.summary,
    'Finished Prepare a release note.: Reviewed team/writer/1/0: Please review: Prepare a release note.',
    'The writer must finish after receiving the reply.');

  const saved: DomainEventEnvelope[] = [];
  const stream = { namespace: storage.record.namespace, streamId: runId };
  for await (const event of storage.eventStore.read(stream)) saved.push(event);
  const order = saved.filter((event) => event.type === 'graph:node-dispatched')
    .map((event) => (event.payload as { nodeId: string }).nodeId);
  assert.deepEqual(order, ['writer', 'reviewer', 'writer']);
  const messages = saved.filter((event) => event.type === 'graph:node-completed').flatMap((event) => {
    const completion = event.payload as { nodeId: string; result: TeamTurnResult };
    return (completion.result.posts ?? []).map((post) => ({ sender: completion.nodeId, text: post.text }));
  });

  // #region projection
  const projection = await projectTeamRooms({ storage, runId, directory: join(temporaryRoot, 'operator-rooms') });
  // #endregion projection
  const reopened = openStorage();
  const loaded = await loadRunDefinition(reopened, runId);
  const replay = await createGraphExecutor({
    runId, graph: compileGraph(teamGraphType, loaded.record.payload.definition.graphDefinition.value as TeamDefinition),
    storage: reopened, nodes, engines: [],
  });
  assert.deepEqual(await replay.run(new AbortController().signal), result);
  const after: DomainEventEnvelope[] = [];
  for await (const event of reopened.eventStore.read(stream)) after.push(event);
  assert.deepEqual(after, saved, 'Completed replay must not add events.');
  report = {
    messages, order,
    answers: output.agents.map((agent) => ({ name: agent.name, summary: agent.result?.summary ?? null })),
    projectionRevision: projection.revision, replayAddedEvents: after.length !== saved.length,
  };
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
const temporaryDirectoryRemoved = await access(temporaryRoot).then(() => false, (error: NodeJS.ErrnoException) => {
  if (error.code !== 'ENOENT') throw error;
  return true;
});
assert.equal(temporaryDirectoryRemoved, true);
console.log(JSON.stringify({ ...report, temporaryDirectoryRemoved }, null, 2));
