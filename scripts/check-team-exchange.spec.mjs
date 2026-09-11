import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import * as runtime from '@obversa/runtime';
import { createLocalRunStorage } from '@obversa/runtime/storage/local';
import { GrokCliEngine } from '@obversa/engine-grok-cli';
import { OpenCodeCliEngine } from '@obversa/engine-opencode-cli';

const marker = 'OBVERSA_STRUCTURED_RESULT_V1\n';
const policy = {
  schemaVersion: 1,
  maxEventPayloadBytes: 64_000,
  maxAppendBatchBytes: 128_000,
  maxArtifactBytes: 1_000_000,
  maxTotalArtifactBytesPerRun: 4_000_000,
  retention: 'until-run-delete',
  sensitiveContent: { marked: 'reject', exact: 'reject', freeText: 'redact-before-hash' },
};
const targets = [
  { adapter: 'grok-cli', provider: 'xai', modelFamily: 'grok-4', model: 'grok-4-example', tools: [] },
  { adapter: 'opencode-cli', provider: 'opencode', modelFamily: 'opencode-fixture', model: 'opencode/x-preview-f-free', tools: [] },
];
const lanes = targets.map((requested, index) => ({
  id: index === 0 ? 'writing' : 'reviewing', requested, knownSubstitutions: [],
}));
const schema = {
  properties: {
    data: {},
    posts: {
      items: {
        properties: {
          mentions: { items: { type: 'string' }, type: 'array' },
          roomId: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['roomId', 'text', 'mentions'],
        type: 'object',
      },
      type: 'array',
    },
    summary: { type: 'string' },
  },
  required: ['summary'],
  type: 'object',
};
const resultContract = {
  record: {
    name: 'team-exchange', version: 1,
    schemaDigest: `sha256:${createHash('sha256').update(JSON.stringify(schema)).digest('hex')}`,
  },
  schema,
  validate(value) {
    assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
    assert.equal(typeof value.summary, 'string');
    if (Object.hasOwn(value, 'posts')) {
      assert.ok(Array.isArray(value.posts));
      for (const post of value.posts) {
        assert.ok(post !== null && typeof post === 'object' && !Array.isArray(post));
        assert.equal(typeof post.roomId, 'string');
        assert.equal(typeof post.text, 'string');
        assert.ok(Array.isArray(post.mentions));
        assert.ok(post.mentions.every((mention) => typeof mention === 'string'));
      }
    }
    const json = JSON.parse(JSON.stringify(value));
    assert.deepEqual(json, value, 'The turn result and optional data must contain only JSON values.');
    return json;
  },
};

function parseResult(part) {
  assert.equal(part.kind, 'assistant');
  assert.ok(part.text.startsWith(marker), 'OpenCode must return the leading structured-result marker.');
  return JSON.parse(part.text.slice(marker.length));
}

function exchangeDefinition(task) {
  return {
    id: 'team-exchange', definitionVersion: 1,
    data: {
      task, globalConcurrency: 1, maxTurnsPerMember: 2,
      communication: { rooms: [{ id: 'review', members: ['writer', 'reviewer'] }], tailMessages: 3 },
    },
    nodes: [
      { id: 'writer', data: { role: 'writer', brief: 'Draft the release note.', lane: lanes[0] } },
      { id: 'reviewer', data: { role: 'reviewer', brief: 'Check the draft.', initialTurn: false, lane: lanes[1] } },
    ],
    edges: [],
  };
}

async function prepareDirectory(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'obversa-team-exchange-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function prepareRun(directory, task) {
  assert.ok(runtime.teamGraphType, 'The public runtime must expose teamGraphType.');
  await mkdir(directory, { recursive: true });
  const executable = join(directory, 'team-exchange-cli.mjs');
  await copyFile(new URL('./fixtures/team-exchange-cli.mjs', import.meta.url), executable);
  await chmod(executable, 0o700);
  await writeFile(join(directory, 'captures.jsonl'), '');
  const host = await openHost(directory);
  const graph = runtime.compileGraph(runtime.teamGraphType, exchangeDefinition(task));
  const packageIdentity = {
    source: 'file:team-exchange-test', version: '1.0.0', digest: `sha256:${'d'.repeat(64)}`,
  };
  await runtime.persistRunDefinition(host.storage, {
    runId: host.runId, eventId: randomUUID(), timestamp: new Date().toISOString(),
    graphDefinition: graph.definition,
    resolvedPlan: runtime.resolveGraphPlan(graph.describe(), {
      package: packageIdentity,
      admission: { package: packageIdentity, permissions: [] },
      executionLanes: lanes.map((lane) => ({ id: lane.id, effective: lane.requested, fallbacks: [] })),
    }),
    resolvedInputs: {}, workspaceBinding: null, hostBinding: null,
  });
  return host;
}

async function openHost(directory, { writerBudget = {}, crash = false } = {}) {
  assert.ok(runtime.teamGraphType, 'The public runtime must expose teamGraphType; rebuild before interpreting a stale export.');
  const storage = createLocalRunStorage({ directory: join(directory, 'storage'), namespace: 'team-exchange', policy });
  const executable = join(directory, 'team-exchange-cli.mjs');
  const capturePath = join(directory, 'captures.jsonl');
  const engines = [
    new GrokCliEngine({
      executable, version: '1.0.5', identity: { provider: 'xai', modelFamily: 'grok-4' },
      permissionMode: 'dontAsk', environment: { OBVERSA_TEAM_CAPTURE: capturePath },
    }),
    new OpenCodeCliEngine({
      executable, version: '1.18.23', identity: { provider: 'opencode', modelFamily: 'opencode-fixture' },
      environment: { OBVERSA_TEAM_CAPTURE: capturePath },
    }),
  ].map((engine, index) => ({
    target: targets[index], engine, hardTokenLimitEnforceable: false,
    selection: {
      adapter: targets[index].adapter, provider: targets[index].provider,
      modelFamily: targets[index].modelFamily, model: targets[index].model,
      adapterVersion: index === 0 ? '1.0.5' : '1.18.23', executable, capabilities: [],
    },
  }));
  const nodes = {};
  for (const member of ['writer', 'reviewer']) {
    const memberDirectory = join(directory, member);
    await mkdir(memberDirectory, { recursive: true });
    nodes[member] = {
      prompt: (input) => JSON.stringify({ member, input }),
      scratchDirectory: memberDirectory,
      workspace: { mode: 'none', directory: null, allowedPaths: [] },
      trustedCaller: {}, permissions: [],
      policy: {
        inputBytes: 100_000, outputBytes: 100_000, timeoutMs: 5_000, teardownGraceMs: 200,
        memoryBytes: 256 * 1_024 * 1_024, filesChanged: 0, linesChanged: 0, callTokens: null,
        ...(member === 'writer' ? writerBudget : {}),
      },
      resultContract, runData: null, parseResult, tokenBudget: null, retrySafe: true,
      decideAction: async () => ({ kind: 'allow' }),
    };
  }
  if (crash) {
    const realStore = storage.eventStore;
    return {
      runId: 'exchange', directory, nodes, engines,
      storage: {
        ...storage,
        eventStore: {
          read: realStore.read.bind(realStore),
          preflightAppend: realStore.preflightAppend.bind(realStore),
          async append(stream, expectedRevision, batch) {
            const revision = await realStore.append(stream, expectedRevision, batch);
            if (batch.some((event) => event.type === 'graph:node-completed'
              && event.payload.nodeId === 'writer'
              && event.payload.result.posts?.some((post) => post.mentions.includes('reviewer')))) {
              process.kill(process.pid, 'SIGKILL');
            }
            return revision;
          },
        },
      },
    };
  }
  return { runId: 'exchange', directory, storage, nodes, engines };
}

async function execute(host, signal) {
  const loaded = await runtime.loadRunDefinition(host.storage, host.runId);
  const graph = runtime.compileGraph(runtime.teamGraphType, loaded.record.payload.definition.graphDefinition.value);
  const executor = await runtime.createGraphExecutor({ ...host, graph });
  return executor.run(signal);
}

async function events(host) {
  const saved = [];
  for await (const event of host.storage.eventStore.read({
    namespace: host.storage.record.namespace, streamId: host.runId,
  })) saved.push(event);
  return saved;
}

async function captures(host) {
  const text = await readFile(join(host.directory, 'captures.jsonl'), 'utf8');
  return text.trim() === '' ? [] : text.trimEnd().split('\n').map((line) => JSON.parse(line));
}

function payloads(saved, type) {
  return saved.filter((event) => event.type === `graph:${type}`).map((event) => event.payload);
}

async function assertExchange(host, task, result) {
  const saved = await events(host);
  const received = await captures(host);
  const dispatched = payloads(saved, 'node-dispatched');
  const completed = payloads(saved, 'node-completed');
  assert.deepEqual(dispatched.map((event) => event.nodeId), ['writer', 'reviewer', 'writer']);
  assert.deepEqual(dispatched.map((event) => event.position), ['team/writer/1', 'team/reviewer/1', 'team/writer/2']);
  assert.equal(new Set(dispatched.map((event) => event.position)).size, 3);
  assert.deepEqual(completed.map((event) => event.nodeId), ['writer', 'reviewer', 'writer']);
  const receipts = payloads(saved, 'engine-attempt-recorded');
  assert.equal(receipts.length, 3);
  assert.deepEqual(receipts.map((event) => event.position), dispatched.map((event) => event.position));
  assert.deepEqual(receipts.map((event) => event.sequence), [1, 1, 1]);
  for (const key of ['requested', 'effective']) {
    assert.deepEqual(receipts.map((event) => event[key]), [
      { adapter: 'grok-cli', provider: 'xai', modelFamily: 'grok-4', model: 'grok-4-example' },
      { adapter: 'opencode-cli', provider: 'opencode', modelFamily: 'opencode-fixture', model: 'opencode/x-preview-f-free' },
      { adapter: 'grok-cli', provider: 'xai', modelFamily: 'grok-4', model: 'grok-4-example' },
    ]);
  }
  assert.equal(received.length, 3, 'Do not deduplicate captures: every process must remain visible.');
  assert.deepEqual(received.map((capture) => capture.member), ['writer', 'reviewer', 'writer']);
  assert.deepEqual(received.map((capture) => capture.adapter), ['grok-cli', 'opencode-cli', 'grok-cli']);
  assert.ok(received.every((capture) => Number.isInteger(capture.pid) && capture.pid > 0));
  assert.equal(new Set(received.map((capture) => capture.pid)).size, 3);
  for (const capture of received) {
    assert.deepEqual(Object.keys(capture.input).sort(), ['brief', 'messages', 'result', 'role', 'task']);
    assert.equal(capture.input.task, task);
    assert.equal(capture.input.role, capture.member);
    assert.equal(capture.input.brief, capture.member === 'writer' ? 'Draft the release note.' : 'Check the draft.');
  }
  const question = {
    id: 'team/writer/1/0', sender: 'writer', position: 'team/writer/1',
    roomId: 'review', text: `Please review: ${task}`, mentions: ['reviewer'],
  };
  const reply = {
    id: 'team/reviewer/1/0', sender: 'reviewer', position: 'team/reviewer/1',
    roomId: 'review', text: `Reviewed team/writer/1/0: Please review: ${task}`, mentions: ['writer'],
  };
  assert.deepEqual(received[0].input.messages, []);
  assert.equal(received[0].input.result, null);
  assert.deepEqual(received[1].input.messages, [question]);
  assert.equal(received[1].input.result, null);
  assert.deepEqual(received[2].input.messages, [question, reply]);
  assert.deepEqual(received[2].input.result, completed[0].result);
  assert.deepEqual(completed[0].result.posts, [{ roomId: 'review', text: question.text, mentions: ['reviewer'] }]);
  assert.deepEqual(completed[1].result.posts, [{ roomId: 'review', text: reply.text, mentions: ['writer'] }]);
  assert.deepEqual(completed[2].result, { summary: `Finished ${task}: ${reply.text}`, data: { replyId: reply.id, reply: reply.text } });
  assert.deepEqual(result, {
    kind: 'complete', output: {
      task,
      agents: [
        { name: 'writer', role: 'writer', result: completed[2].result },
        { name: 'reviewer', role: 'reviewer', result: completed[1].result },
      ],
    },
  });
  const positionOf = (type, position) => saved.findIndex((event) => event.type === `graph:${type}` && event.payload.position === position);
  assert.ok(positionOf('node-completed', 'team/writer/1') < positionOf('node-dispatched', 'team/reviewer/1'));
  assert.ok(positionOf('node-completed', 'team/reviewer/1') < positionOf('node-dispatched', 'team/writer/2'));
  return { saved, received, dispatched, completed };
}

async function assertReplay(host, result, signal) {
  const beforeEvents = await events(host);
  const beforeCaptures = await captures(host);
  const fresh = await openHost(host.directory);
  assert.deepEqual(await execute(fresh, signal), result);
  assert.deepEqual(await events(fresh), beforeEvents);
  assert.deepEqual(await captures(fresh), beforeCaptures);
}

async function crashChild(directory, signal) {
  signal.throwIfAborted();
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--crash-child', directory], {
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let output = '';
  let stoppedFor = null;
  let childError;
  let forceTimeout;
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.once('error', (error) => { childError = error; });
  const closed = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const stop = (reason) => {
    if (stoppedFor !== null) return;
    stoppedFor = reason;
    // The host aborts its executor so adapters can reap their detached commands.
    child.kill('SIGTERM');
    forceTimeout = setTimeout(() => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') childError = error;
      }
    }, 5_000);
  };
  const onAbort = () => stop('test abort');
  signal.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => stop('host timeout'), 20_000);
  try {
    const result = await closed;
    if (childError) throw childError;
    assert.equal(stoppedFor, null, `Child stopped for ${stoppedFor} instead of the saved-question crash.\n${output}`);
    assert.equal(result.code, null, output);
    assert.equal(result.signal, 'SIGKILL', output);
  } finally {
    clearTimeout(timeout);
    clearTimeout(forceTimeout);
    signal.removeEventListener('abort', onAbort);
  }
}

if (process.argv[2] === '--crash-child') {
  assert.ok(process.argv[3], 'The crash host requires a directory.');
  const controller = new AbortController();
  const onTerminate = () => controller.abort();
  process.once('SIGTERM', onTerminate);
  try {
    await execute(await openHost(process.argv[3], { crash: true }), controller.signal);
  } finally {
    process.removeListener('SIGTERM', onTerminate);
  }
  throw new Error('The crash host returned without being killed after the saved question.');
} else {
  test('public team form and room projection are exported', () => {
    assert.ok(runtime.teamGraphType, 'The public runtime must expose teamGraphType.');
    assert.equal(typeof runtime.projectTeamRooms, 'function', 'The public runtime must expose projectTeamRooms.');
  });

  test('real Grok/OpenCode turns save the exchange and project it without new work', { timeout: 40_000 }, async (t) => {
    const directory = await prepareDirectory(t);
    const task = `Prepare release note ${randomUUID()}.`;
    const host = await prepareRun(directory, task);
    const result = await execute(host, t.signal);
    const proof = await assertExchange(host, task, result);
    await assertReplay(host, result, t.signal);
    assert.equal(typeof runtime.projectTeamRooms, 'function', 'The public runtime must expose projectTeamRooms.');
    const roomDirectory = join(directory, 'room-files');
    const view = await runtime.projectTeamRooms({ storage: host.storage, runId: host.runId, directory: roomDirectory });
    assert.equal(view.revision, proof.saved.at(-1).revision);
    assert.deepEqual(view.files.map((file) => file.roomId), ['review']);
    const childPath = relative(roomDirectory, view.files[0].path);
    assert.ok(childPath !== '' && !isAbsolute(childPath) && !/^\.\.(?:[/\\]|$)/u.test(childPath));
    const content = await readFile(view.files[0].path, 'utf8');
    assert.ok(content.endsWith('\n'));
    const lines = content.slice(0, -1).split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^writer\b/u);
    assert.ok(lines[0].includes('team/writer/1/0'));
    assert.ok(lines[0].includes(`Please review: ${task}`));
    assert.match(lines[1], /^reviewer\b/u);
    assert.ok(lines[1].includes('team/reviewer/1/0'));
    assert.ok(lines[1].includes(`Reviewed team/writer/1/0: Please review: ${task}`));
    assert.deepEqual(await events(host), proof.saved);
    assert.deepEqual(await captures(host), proof.received);
  });

  test('SIGKILL after the saved writer question resumes only reviewer and writer', { timeout: 60_000 }, async (t) => {
    const directory = await prepareDirectory(t);
    const task = `Prepare crash-safe release note ${randomUUID()}.`;
    const uninterrupted = await prepareRun(join(directory, 'uninterrupted'), task);
    const expectedResult = await execute(uninterrupted, t.signal);
    const expected = await assertExchange(uninterrupted, task, expectedResult);
    const interrupted = await prepareRun(join(directory, 'interrupted'), task);
    await crashChild(interrupted.directory, t.signal);
    const reopened = await openHost(interrupted.directory);
    const prefix = await events(reopened);
    assert.deepEqual(payloads(prefix, 'node-dispatched').map((event) => event.nodeId), ['writer']);
    const completions = payloads(prefix, 'node-completed');
    assert.equal(completions.length, 1);
    assert.equal(completions[0].nodeId, 'writer');
    assert.deepEqual(completions[0].result.posts, [{ roomId: 'review', text: `Please review: ${task}`, mentions: ['reviewer'] }]);
    const initialCaptures = await captures(reopened);
    assert.equal(initialCaptures.length, 1);
    assert.equal(initialCaptures[0].member, 'writer');
    const actualResult = await execute(reopened, t.signal);
    const actual = await assertExchange(reopened, task, actualResult);
    assert.deepEqual(actual.saved.slice(0, prefix.length), prefix);
    assert.deepEqual(actual.received.slice(0, 1), initialCaptures);
    assert.deepEqual(actual.received.slice(1).map((capture) => capture.member), ['reviewer', 'writer']);
    assert.deepEqual(actualResult, expectedResult);
    assert.deepEqual(actual.dispatched, expected.dispatched);
    assert.deepEqual(actual.completed, expected.completed);
    await assertReplay(reopened, actualResult, t.signal);
  });

  for (const budget of ['inputBytes', 'outputBytes']) {
    test(`the writer ${budget} limit blocks its post and the reviewer`, { timeout: 40_000 }, async (t) => {
      const directory = await prepareDirectory(t);
      const task = `Prepare budget-bound release note ${randomUUID()}.`;
      const control = await prepareRun(join(directory, 'control'), task);
      await assertExchange(control, task, await execute(control, t.signal));
      const limited = await prepareRun(join(directory, 'limited'), task);
      const host = await openHost(limited.directory, { writerBudget: { [budget]: 1 } });
      const result = await execute(host, t.signal);
      assert.equal(result.kind, 'fail');
      assert.equal(result.code, 'TEAM_NODE_FAILED');
      const saved = await events(host);
      assert.deepEqual(payloads(saved, 'node-dispatched').map((event) => event.nodeId), ['writer']);
      assert.deepEqual(payloads(saved, 'node-completed'), []);
      const failures = payloads(saved, 'node-failed');
      assert.equal(failures.length, 1);
      assert.equal(failures[0].nodeId, 'writer');
      assert.equal(typeof failures[0].code, 'string');
      t.diagnostic(JSON.stringify({ budget, failure: failures[0].code, result: result.code }));
      if (budget === 'inputBytes') {
        assert.equal(failures[0].code, 'INPUT_LIMIT');
        assert.deepEqual(await captures(host), []);
      } else {
        assert.deepEqual((await captures(host)).map((capture) => capture.member), ['writer']);
      }
    });
  }
}
