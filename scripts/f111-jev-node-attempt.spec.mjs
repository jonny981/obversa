import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  compileGraph,
  createGraphExecutor,
  dagGraphType,
  persistRunDefinition,
  resolveGraphPlan,
} from '@obversa/runtime';
import { createLocalRunStorage } from '@obversa/runtime/storage/local';
import { JevApiEngine } from '@obversa/engine-jev-api';

/**
 * F111 runtime-node integration: a real dag node attempt through
 * createGraphExecutor + createLocalRunStorage, bound to the Jev engine.
 * The HTTP stub is local and synthetic — no live API is contacted.
 */

const API_KEY = 'test-key-not-a-credential';
const TARGET = {
  adapter: 'jev-api',
  provider: 'typesafe',
  modelFamily: 'jev',
  model: 'jev-fixture',
  tools: [],
};
const QUESTIONS = {
  send_back: {
    type: 'noul',
    instructions: 'Should this work be sent back?',
    criteria: { true: 'A finding is user-visible', false: 'Advisories only' },
  },
  which_stage: {
    type: 'choice',
    instructions: 'Which stage should it return to?',
    criteria: { implement: 'code defect', test: 'tests missing', none: 'nothing to send back' },
  },
};
const STATE = { stage: 'review', findings: ['a user-visible defect'], testsPassing: true };

const roots = [];
test.after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jev-node-attempt-')));
  roots.push(root);
  return root;
}

async function stubServer(response) {
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      calls.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'),
      });
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  test.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${port}/v1/systemone`, calls };
}

const storagePolicy = {
  schemaVersion: 1,
  maxEventPayloadBytes: 64_000,
  maxAppendBatchBytes: 128_000,
  maxArtifactBytes: 1_000_000,
  maxTotalArtifactBytesPerRun: 4_000_000,
  retention: 'until-run-delete',
  sensitiveContent: { marked: 'reject', exact: 'reject', freeText: 'redact-before-hash' },
};

const packageIdentity = {
  source: 'npm:@obversa/f111-jev-node-test',
  version: '0.1.0',
  digest: `sha256:${'5'.repeat(64)}`,
};

async function storedGraph(root) {
  const graph = compileGraph(dagGraphType, {
    id: 'jev-node-test',
    definitionVersion: 1,
    data: {
      globalConcurrency: 1,
      keyedConcurrency: {},
      stopOnError: true,
      retryCapPerNode: 0,
    },
    nodes: [{
      id: 'decide',
      data: {
        kind: 'required',
        key: null,
        lane: { id: 'jev', requested: TARGET, knownSubstitutions: [] },
      },
    }],
    edges: [],
  });
  const plan = resolveGraphPlan(graph.describe(), {
    package: packageIdentity,
    admission: { package: packageIdentity, permissions: [] },
    executionLanes: [{ id: 'jev', effective: TARGET }],
  });
  const runId = `jev-node-${randomUUID()}`;
  const storage = createLocalRunStorage({
    directory: join(root, 'storage'),
    namespace: 'jev-node-test',
    policy: storagePolicy,
  });
  await persistRunDefinition(storage, {
    runId,
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    graphDefinition: graph.definition,
    resolvedPlan: plan,
    resolvedInputs: {},
    workspaceBinding: null,
    hostBinding: null,
  });
  return { graph, runId, storage };
}

async function readEvents(storage, runId) {
  const events = [];
  for await (const event of storage.eventStore.read({
    namespace: storage.record.namespace,
    streamId: runId,
  })) events.push(event);
  return events;
}

async function executorFor({ root, graph, runId, storage, engine, selection }) {
  return await createGraphExecutor({
    runId,
    graph,
    storage,
    engines: [{ target: TARGET, selection, engine, hardTokenLimitEnforceable: false }],
    nodes: {
      decide: {
        // The documented caller pattern: the binding encodes selected state
        // and questions as the adapter's {state, questions} JSON document.
        prompt: (input) => JSON.stringify({ state: { ...STATE, dispatch: input }, questions: QUESTIONS }),
        scratchDirectory: root,
        workspace: { mode: 'none', directory: null, allowedPaths: [] },
        trustedCaller: {},
        permissions: [],
        policy: {
          inputBytes: 100_000,
          outputBytes: 100_000,
          timeoutMs: 5_000,
          teardownGraceMs: 100,
          memoryBytes: 10_000_000,
          filesChanged: 0,
          linesChanged: 0,
          callTokens: null,
        },
        resultContract: null,
        runData: null,
        parseResult: null,
        tokenBudget: null,
        decideAction: async () => ({ kind: 'allow' }),
      },
    },
  });
}

test('a dag node attempt reaches the adapter and completes with the structured answer', async () => {
  // A genuinely unconfident choice answer (confidence 0.06) completes and is
  // recorded verbatim: the node does not judge confidence — that is caller
  // routing. The noul answer stays probability-only, with no confidence field.
  const answers = {
    send_back: { type: 'noul', noul: 0.85 },
    which_stage: { type: 'choice', choice: 'none', confidence: 0.06 },
  };
  // No model echo and no usage fields: the null-effective identity and the
  // unknown usage receipt must flow through the recorded attempt untouched.
  const stub = await stubServer({ status: 200, body: { answers } });
  const root = await temporaryRoot();
  const { graph, runId, storage } = await storedGraph(root);
  const engine = new JevApiEngine({ endpoint: stub.url, apiKey: API_KEY, adapterVersion: '0.1.0' });
  const signal = new AbortController().signal;
  const selection = await engine.admit({ model: 'jev-fixture', workspaceMode: 'none' }, signal);

  const result = await (await executorFor({ root, graph, runId, storage, engine, selection })).run(signal);

  assert.equal(result.kind, 'complete', JSON.stringify(result));

  assert.equal(stub.calls.length, 1, 'the node should make exactly one wire call');
  const call = stub.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, '/v1/systemone');
  assert.equal(call.authorization, `Bearer ${API_KEY}`);
  assert.equal(call.body.model, 'jev-fixture');
  assert.deepEqual(call.body.questions, QUESTIONS);
  assert.equal(call.body.state.stage, 'review');

  const events = await readEvents(storage, runId);
  const completed = events.find((event) => event.type === 'graph:node-completed');
  assert.ok(completed, `no node-completed event in ${events.map((e) => e.type).join(', ')}`);
  assert.equal(completed.payload.nodeId, 'decide');
  assert.deepEqual(completed.payload.result, answers);
  assert.ok(!events.some((event) => event.type === 'graph:node-failed'),
    'the low-confidence answer completed without any recorded node failure');

  const attempt = events.find((event) => event.type === 'graph:engine-attempt-recorded');
  assert.ok(attempt, 'no engine-attempt-recorded event');
  assert.deepEqual(attempt.payload.effective, {
    adapter: 'jev-api',
    provider: 'typesafe',
    modelFamily: null,
    model: null,
  });
});

test('an unreachable endpoint fails the node rather than inventing an answer', async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));

  const root = await temporaryRoot();
  const { graph, runId, storage } = await storedGraph(root);
  const engine = new JevApiEngine({
    endpoint: `http://127.0.0.1:${port}/v1/systemone`,
    apiKey: API_KEY,
    adapterVersion: '0.1.0',
  });
  const signal = new AbortController().signal;
  const selection = await engine.admit({ model: 'jev-fixture', workspaceMode: 'none' }, signal);

  const result = await (await executorFor({ root, graph, runId, storage, engine, selection })).run(signal);

  assert.equal(result.kind, 'fail', JSON.stringify(result));
  const events = await readEvents(storage, runId);
  const failed = events.find((event) => event.type === 'graph:node-failed');
  assert.ok(failed, `no node-failed event in ${events.map((e) => e.type).join(', ')}`);
  assert.equal(failed.payload.nodeId, 'decide');
});
