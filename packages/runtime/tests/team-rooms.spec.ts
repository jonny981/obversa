import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as runtime from '../src/api.ts';
import { createLocalRunStorage } from '../src/storage/local.ts';
import type {
  CompiledGraphType,
  DomainEventEnvelope,
  GraphNodeBinding,
  GraphType,
  JsonValue,
  RunStorageBinding,
  StreamRevision,
  TeamDefinition,
} from '../src/api.ts';

// Real work: these tests write files to temporary directories on disk, so
// this file declares its own time limit; the suite default is a hang guard,
// not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    writeFile: vi.fn(actual.writeFile),
  };
});

type ProjectTeamRooms = (input: {
  readonly storage: RunStorageBinding;
  readonly runId: string;
  readonly directory: string;
}) => Promise<{
  readonly revision: StreamRevision;
  readonly files: readonly { readonly roomId: string; readonly path: string }[];
}>;

interface StoredTeamRun {
  readonly graph: CompiledGraphType;
  readonly root: string;
  readonly runId: string;
  readonly storage: RunStorageBinding;
}

const roots: string[] = [];
let sequence = 0;

const policy = {
  schemaVersion: 1,
  maxEventPayloadBytes: 64_000,
  maxAppendBatchBytes: 128_000,
  maxArtifactBytes: 1_000_000,
  maxTotalArtifactBytesPerRun: 4_000_000,
  retention: 'until-run-delete',
  sensitiveContent: {
    marked: 'reject',
    exact: 'reject',
    freeText: 'redact-before-hash',
  },
} as const;

const packageIdentity = {
  source: 'npm:@example/team-room-tests',
  version: '1.0.0',
  digest: `sha256:${'7'.repeat(64)}` as const,
};

const questionText = 'Please check whether the launch date is correct.';
const replyText = 'The launch date is correct.';

const exchangeDefinition: TeamDefinition = {
  id: 'release-team',
  definitionVersion: 1,
  data: {
    task: 'Prepare a release note.',
    globalConcurrency: 1,
    maxTurnsPerMember: 2,
    communication: {
      rooms: [{ id: 'review', members: ['writer', 'reviewer'] }],
      tailMessages: 3,
    },
  },
  nodes: [
    { id: 'writer', data: { role: 'writer', brief: 'Draft the release note.' } },
    {
      id: 'reviewer',
      data: { role: 'reviewer', brief: 'Check the date.', initialTurn: false },
    },
  ],
  edges: [],
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function teamForm(typeVersion = 1): GraphType {
  const form = (runtime as typeof runtime & { teamGraphType?: GraphType }).teamGraphType;
  expect(form, 'The public runtime must expose teamGraphType before room projection can run.')
    .toBeDefined();
  return typeVersion === 1 ? form! : { ...form!, version: typeVersion };
}

function projectTeamRooms(): ProjectTeamRooms {
  const project = (runtime as typeof runtime & { projectTeamRooms?: unknown }).projectTeamRooms;
  expect(project, 'The public runtime must expose projectTeamRooms.').toBeTypeOf('function');
  return project as ProjectTeamRooms;
}

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'obversa-team-rooms-')));
  roots.push(root);
  return root;
}

function localStorage(root: string, namespace = `team-room-tests-${sequence += 1}`): RunStorageBinding {
  return createLocalRunStorage({ directory: join(root, 'storage'), namespace, policy });
}

async function persistGraphRun(
  root: string,
  storage: RunStorageBinding,
  runId: string,
  graph: CompiledGraphType,
): Promise<StoredTeamRun> {
  const description = graph.describe();
  await runtime.persistRunDefinition(storage, {
    runId,
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    graphDefinition: graph.definition,
    resolvedPlan: runtime.resolveGraphPlan(description, {
      package: packageIdentity,
      admission: { package: packageIdentity, permissions: [] },
      executionLanes: [],
    }),
    resolvedInputs: {},
    workspaceBinding: null,
    hostBinding: null,
  });
  return { graph, root, runId, storage };
}

async function storedTeamRun(
  definition: TeamDefinition,
  options: {
    readonly root?: string;
    readonly runId?: string;
    readonly storage?: RunStorageBinding;
    readonly typeVersion?: number;
  } = {},
): Promise<StoredTeamRun> {
  const root = options.root ?? await temporaryRoot();
  const storage = options.storage ?? localStorage(root);
  const runId = options.runId ?? `team-room-run-${sequence += 1}`;
  const graph = runtime.compileGraph(teamForm(options.typeVersion), definition);
  return persistGraphRun(root, storage, runId, graph);
}

function dataBinding(
  root: string,
  runData: NonNullable<GraphNodeBinding['runData']>,
): GraphNodeBinding {
  return {
    prompt: null,
    scratchDirectory: root,
    workspace: { mode: 'none', directory: null, allowedPaths: [] },
    trustedCaller: {},
    permissions: [],
    policy: {
      inputBytes: 100_000,
      outputBytes: 100_000,
      timeoutMs: 5_000,
      teardownGraceMs: 100,
      memoryBytes: 100_000_000,
      filesChanged: 0,
      linesChanged: 0,
      callTokens: null,
    },
    resultContract: null,
    runData,
    parseResult: null,
    tokenBudget: null,
    decideAction: async () => ({ kind: 'allow' }),
  };
}

async function executeWithData(
  run: StoredTeamRun,
  nodes: Readonly<Record<string, NonNullable<GraphNodeBinding['runData']>>>,
) {
  const executor = await runtime.createGraphExecutor({
    ...run,
    nodes: Object.fromEntries(Object.entries(nodes).map(([id, runData]) => [
      id,
      dataBinding(run.root, runData),
    ])),
    engines: [],
  });
  return executor.run(new AbortController().signal);
}

async function readEvents(
  storage: RunStorageBinding,
  runId: string,
): Promise<readonly DomainEventEnvelope[]> {
  const events: DomainEventEnvelope[] = [];
  for await (const event of storage.eventStore.read({
    namespace: storage.record.namespace,
    streamId: runId,
  })) events.push(event);
  return events;
}

async function appendEvent(
  storage: RunStorageBinding,
  runId: string,
  type: string,
  payload: JsonValue,
  version = 1,
): Promise<void> {
  const events = await readEvents(storage, runId);
  await storage.eventStore.append(
    { namespace: storage.record.namespace, streamId: runId },
    events.at(-1)?.revision ?? 0,
    [runtime.validateNewDomainEvent({
      eventId: randomUUID(),
      type,
      version,
      timestamp: new Date().toISOString(),
      correlationId: runId,
      causationId: null,
      payload,
    })],
  );
}

function rejectAppends(storage: RunStorageBinding): RunStorageBinding {
  const eventStore = storage.eventStore;
  return {
    ...storage,
    eventStore: {
      preflightAppend: eventStore.preflightAppend.bind(eventStore),
      read: eventStore.read.bind(eventStore),
      append: async () => {
        throw new Error('Room projection must not append events.');
      },
    },
  };
}

function fileFor(
  view: Awaited<ReturnType<ProjectTeamRooms>>,
  roomId: string,
): string {
  const file = view.files.find((candidate) => candidate.roomId === roomId);
  expect(file, `Projection must return the file for room ${JSON.stringify(roomId)}.`)
    .toBeDefined();
  return file!.path;
}

function expectInside(directory: string, path: string): void {
  const child = relative(resolve(directory), resolve(path));
  expect(child).not.toBe('');
  expect(isAbsolute(child)).toBe(false);
  expect(child).not.toMatch(/^\.\.(?:[/\\]|$)/u);
}

function occurrences(value: string, literal: string): number {
  return value.split(literal).length - 1;
}

function nonemptyLines(value: string): readonly string[] {
  expect(value.endsWith('\n')).toBe(true);
  return value.slice(0, -1).split('\n');
}

describe('team room projection', () => {
  it('rebuilds the exact saved exchange without adding an event', async () => {
    const run = await storedTeamRun(exchangeDefinition);
    let writerTurns = 0;
    const calls: string[] = [];
    const outcome = await executeWithData(run, {
      writer: async (): Promise<JsonValue> => {
        calls.push('writer');
        writerTurns += 1;
        return writerTurns === 1
          ? {
              summary: 'Draft ready for review.',
              posts: [{ roomId: 'review', text: questionText, mentions: ['reviewer'] }],
            }
          : { summary: 'Release note finished.' };
      },
      reviewer: async () => {
        calls.push('reviewer');
        return {
          summary: 'Date checked.',
          posts: [{ roomId: 'review', text: replyText, mentions: ['writer'] }],
        };
      },
    });
    expect(outcome).toEqual({
      kind: 'complete',
      output: {
        task: 'Prepare a release note.',
        agents: [
          { name: 'writer', role: 'writer', result: { summary: 'Release note finished.' } },
          {
            name: 'reviewer',
            role: 'reviewer',
            result: {
              summary: 'Date checked.',
              posts: [{ roomId: 'review', text: replyText, mentions: ['writer'] }],
            },
          },
        ],
      },
    });
    expect(calls).toEqual(['writer', 'reviewer', 'writer']);

    await appendEvent(run.storage, run.runId, 'host:checkpoint', { name: 'after-messages' });
    const before = await readEvents(run.storage, run.runId);
    const directory = join(run.root, 'room-files');
    const view = await projectTeamRooms()({
      storage: rejectAppends(run.storage),
      runId: run.runId,
      directory,
    });

    expect(view.revision).toBe(before.at(-1)!.revision);
    expect(view.files.map((file) => file.roomId)).toEqual(['review']);
    expect(await readEvents(run.storage, run.runId)).toEqual(before);
    const path = fileFor(view, 'review');
    expectInside(directory, path);
    const firstBytes = await readFile(path);
    const content = firstBytes.toString('utf8');
    const lines = nonemptyLines(content);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^writer\b/u);
    expect(lines[0]).toContain('team/writer/1/0');
    expect(lines[0]).toContain(questionText);
    expect(lines[0]).toContain('reviewer');
    expect(lines[1]).toMatch(/^reviewer\b/u);
    expect(lines[1]).toContain('team/reviewer/1/0');
    expect(lines[1]).toContain(replyText);
    expect(lines[1]).toContain('writer');
    expect(occurrences(content, questionText)).toBe(1);
    expect(occurrences(content, replyText)).toBe(1);

    await unlink(path);
    const rebuilt = await projectTeamRooms()({
      storage: rejectAppends(run.storage),
      runId: run.runId,
      directory,
    });
    expect(rebuilt).toEqual(view);
    expect(await readFile(path)).toEqual(firstBytes);
    expect(await readEvents(run.storage, run.runId)).toEqual(before);
  });

  it('keeps unsafe room IDs and control-filled text inside safe one-line files', async () => {
    const root = await temporaryRoot();
    const traversalRoom = '../outside.txt';
    const longRoom = `long-${'x'.repeat(300)}`;
    const unsafeText = 'line\ncarriage\rtab\tescape\u001bdel\u007fc1\u0085separator\u2028paragraph\u2029done';
    const escapedText = 'line\\ncarriage\\rtab\\tescape\\u001bdel\\u007fc1\\u0085separator\\u2028paragraph\\u2029done';
    const definition: TeamDefinition = {
      id: 'unsafe-room-team',
      definitionVersion: 1,
      data: {
        task: 'Write unsafe room samples.',
        globalConcurrency: 1,
        maxTurnsPerMember: 1,
        communication: {
          rooms: [
            { id: traversalRoom, members: ['writer'] },
            { id: longRoom, members: ['writer'] },
          ],
          tailMessages: 2,
        },
      },
      nodes: [{ id: 'writer', data: { role: 'writer', brief: 'Write both samples.' } }],
      edges: [],
    };
    const run = await storedTeamRun(definition, { root });
    await executeWithData(run, {
      writer: async () => ({
        summary: 'Samples written.',
        posts: [
          { roomId: traversalRoom, text: unsafeText, mentions: [] },
          { roomId: longRoom, text: 'Long room content.', mentions: [] },
        ],
      }),
    });

    const directory = join(root, 'room-files');
    await mkdir(directory);
    const unrelatedPath = join(directory, 'operator-notes.bin');
    const unrelatedBytes = Buffer.from([0, 1, 2, 3, 255]);
    await writeFile(unrelatedPath, unrelatedBytes);
    const outsidePath = join(root, 'outside.txt');
    const outsideWithSuffixPath = join(root, 'outside.txt.txt');
    await writeFile(outsidePath, 'outside must stay unchanged');
    await writeFile(outsideWithSuffixPath, 'outside suffix must stay unchanged');

    const view = await projectTeamRooms()({ storage: run.storage, runId: run.runId, directory });
    expect(view.files.map((file) => file.roomId)).toEqual([traversalRoom, longRoom]);
    expect(await readFile(unrelatedPath)).toEqual(unrelatedBytes);
    expect(await readFile(outsidePath, 'utf8')).toBe('outside must stay unchanged');
    expect(await readFile(outsideWithSuffixPath, 'utf8')).toBe('outside suffix must stay unchanged');
    for (const file of view.files) {
      expectInside(directory, file.path);
      expect(basename(file.path).length).toBeLessThan(256);
      expect(file.path.endsWith('.txt')).toBe(true);
    }
    expect(fileFor(view, traversalRoom)).not.toBe(fileFor(view, longRoom));

    const unsafePath = fileFor(view, traversalRoom);
    const unsafeBytes = await readFile(unsafePath);
    const unsafeLine = nonemptyLines(unsafeBytes.toString('utf8'));
    expect(unsafeLine).toHaveLength(1);
    expect(unsafeLine[0]).toContain(escapedText);
    expect(unsafeLine[0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);

    const symlinkTarget = join(root, 'symlink-target.txt');
    await writeFile(symlinkTarget, 'outside symlink target must stay unchanged');
    await unlink(unsafePath);
    await symlink(symlinkTarget, unsafePath);
    const rebuilt = await projectTeamRooms()({ storage: run.storage, runId: run.runId, directory });
    expect(fileFor(rebuilt, traversalRoom)).toBe(unsafePath);
    expect((await lstat(unsafePath)).isSymbolicLink()).toBe(false);
    expect(await readFile(unsafePath)).toEqual(unsafeBytes);
    expect(await readFile(symlinkTarget, 'utf8')).toBe('outside symlink target must stay unchanged');
    expect(await readFile(unrelatedPath)).toEqual(unrelatedBytes);
  });

  it('preserves a pre-existing temporary file when exclusive creation fails', async () => {
    const run = await storedTeamRun(exchangeDefinition);
    const directory = join(run.root, 'room-files');
    const collisionBytes = Buffer.from('foreign temporary bytes');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let collisionPath: string | undefined;
    const collide = async (path: unknown): Promise<void> => {
      if (collisionPath !== undefined) return;
      collisionPath = String(path);
      await actual.writeFile(collisionPath, collisionBytes, { flag: 'wx', mode: 0o600 });
    };
    vi.mocked(open).mockImplementation(async (...args) => {
      if (args[1] === 'wx') await collide(args[0]);
      return actual.open(...args);
    });
    vi.mocked(writeFile).mockImplementation(async (...args) => {
      const options = args[2];
      if (
        typeof options === 'object'
        && options !== null
        && 'flag' in options
        && options.flag === 'wx'
      ) await collide(args[0]);
      return actual.writeFile(...args);
    });

    try {
      await expect(projectTeamRooms()({ storage: run.storage, runId: run.runId, directory }))
        .rejects.toMatchObject({ code: 'EEXIST' });
      expect(collisionPath).toBeDefined();
      expect(await readFile(collisionPath!)).toEqual(collisionBytes);
    } finally {
      vi.mocked(open).mockImplementation(actual.open);
      vi.mocked(writeFile).mockImplementation(actual.writeFile);
    }
  });

  it('writes empty declared rooms and returns no files when communication is omitted', async () => {
    const root = await temporaryRoot();
    const storage = localStorage(root);
    const withEmptyRoom: TeamDefinition = {
      id: 'empty-room-team',
      definitionVersion: 1,
      data: {
        task: 'Wait for a message.',
        globalConcurrency: 1,
        maxTurnsPerMember: 1,
        communication: {
          rooms: [{ id: 'empty-room', members: ['writer'] }],
          tailMessages: 1,
        },
      },
      nodes: [{
        id: 'writer',
        data: { role: 'writer', brief: 'Wait.', initialTurn: false },
      }],
      edges: [],
    };
    const withoutCommunication: TeamDefinition = {
      ...withEmptyRoom,
      id: 'no-room-team',
      data: {
        task: 'Work without rooms.',
        globalConcurrency: 1,
        maxTurnsPerMember: 1,
      },
    };
    const empty = await storedTeamRun(withEmptyRoom, {
      root,
      storage,
      runId: 'empty-room-run',
    });
    const none = await storedTeamRun(withoutCommunication, {
      root,
      storage,
      runId: 'no-room-run',
    });
    const directory = join(root, 'room-files');

    const emptyView = await projectTeamRooms()({ storage, runId: empty.runId, directory });
    expect(emptyView.revision).toBe((await readEvents(storage, empty.runId)).at(-1)!.revision);
    expect(emptyView.files.map((file) => file.roomId)).toEqual(['empty-room']);
    expect(await readFile(fileFor(emptyView, 'empty-room'), 'utf8')).toBe('');

    const noRoomView = await projectTeamRooms()({ storage, runId: none.runId, directory });
    expect(noRoomView.revision).toBe((await readEvents(storage, none.runId)).at(-1)!.revision);
    expect(noRoomView.files).toEqual([]);
    expect(await readFile(fileFor(emptyView, 'empty-room'), 'utf8')).toBe('');
  });

  it('does not overwrite another run projected into the same directory', async () => {
    const root = await temporaryRoot();
    const storage = localStorage(root);
    const definition = (id: string): TeamDefinition => ({
      id,
      definitionVersion: 1,
      data: {
        task: `Write ${id}.`,
        globalConcurrency: 1,
        maxTurnsPerMember: 1,
        communication: {
          rooms: [{ id: 'shared-room', members: ['writer'] }],
          tailMessages: 1,
        },
      },
      nodes: [{ id: 'writer', data: { role: 'writer', brief: `Write ${id}.` } }],
      edges: [],
    });
    const first = await storedTeamRun(definition('first-team'), {
      root,
      storage,
      runId: 'first-team-run',
    });
    const second = await storedTeamRun(definition('second-team'), {
      root,
      storage,
      runId: 'second-team-run',
    });
    await executeWithData(first, {
      writer: async () => ({
        summary: 'First saved.',
        posts: [{ roomId: 'shared-room', text: 'FIRST_RUN_MESSAGE', mentions: [] }],
      }),
    });
    await executeWithData(second, {
      writer: async () => ({
        summary: 'Second saved.',
        posts: [{ roomId: 'shared-room', text: 'SECOND_RUN_MESSAGE', mentions: [] }],
      }),
    });
    const directory = join(root, 'shared-room-files');

    const firstView = await projectTeamRooms()({ storage, runId: first.runId, directory });
    const firstPath = fileFor(firstView, 'shared-room');
    const firstBytes = await readFile(firstPath);
    const secondView = await projectTeamRooms()({ storage, runId: second.runId, directory });
    const secondPath = fileFor(secondView, 'shared-room');

    expect(secondPath).not.toBe(firstPath);
    expect(await readFile(firstPath)).toEqual(firstBytes);
    expect(firstBytes.toString('utf8')).toContain('FIRST_RUN_MESSAGE');
    expect(await readFile(secondPath, 'utf8')).toContain('SECOND_RUN_MESSAGE');
  });

  it.each([
    { name: 'a non-team graph', kind: 'dag' },
    { name: 'a team graph with the wrong type version', kind: 'team-v2' },
  ])('refuses $name before creating a room file', async ({ kind }) => {
    const root = await temporaryRoot();
    const storage = localStorage(root);
    const runId = `wrong-graph-${sequence += 1}`;
    const graph = kind === 'dag'
      ? runtime.compileGraph(runtime.dagGraphType, {
          id: 'not-a-team',
          definitionVersion: 1,
          data: {
            globalConcurrency: 1,
            keyedConcurrency: {},
            stopOnError: true,
            retryCapPerNode: 0,
          },
          nodes: [{ id: 'writer', data: { kind: 'required', key: null } }],
          edges: [],
        })
      : runtime.compileGraph(teamForm(2), exchangeDefinition);
    await persistGraphRun(root, storage, runId, graph);
    const directory = join(root, 'room-files');
    await mkdir(directory);
    await writeFile(join(directory, 'keep.txt'), 'keep this file');

    await expect(projectTeamRooms()({ storage, runId, directory })).rejects.toMatchObject({
      name: 'GraphExecutionError',
      code: 'STORED_GRAPH_MISMATCH',
    });
    expect(await readdir(directory)).toEqual(['keep.txt']);
    expect(await readFile(join(directory, 'keep.txt'), 'utf8')).toBe('keep this file');
  });

  it('rejects a malformed matching saved post before creating a room file', async () => {
    const run = await storedTeamRun(exchangeDefinition);
    await appendEvent(run.storage, run.runId, 'graph:node-dispatched', {
      nodeId: 'writer',
      position: 'team/writer/1',
    });
    await appendEvent(run.storage, run.runId, 'graph:node-completed', {
      nodeId: 'writer',
      position: 'team/writer/1',
      result: {
        summary: 'Malformed post.',
        posts: [{ roomId: 'review', text: 7, mentions: ['reviewer'] }],
      },
    });
    const before = await readEvents(run.storage, run.runId);
    const directory = join(run.root, 'room-files');
    await mkdir(directory);
    await writeFile(join(directory, 'keep.txt'), 'keep this file');

    await expect(projectTeamRooms()({
      storage: rejectAppends(run.storage),
      runId: run.runId,
      directory,
    })).rejects.toBeInstanceOf(runtime.GraphValidationError);
    expect(await readdir(directory)).toEqual(['keep.txt']);
    expect(await readFile(join(directory, 'keep.txt'), 'utf8')).toBe('keep this file');
    expect(await readEvents(run.storage, run.runId)).toEqual(before);
  });

  it('rejects a matching version-2 completion before creating a room file', async () => {
    const run = await storedTeamRun(exchangeDefinition);
    await appendEvent(run.storage, run.runId, 'graph:node-dispatched', {
      nodeId: 'writer',
      position: 'team/writer/1',
    });
    await appendEvent(run.storage, run.runId, 'graph:node-completed', {
      nodeId: 'writer',
      position: 'team/writer/1',
      result: {
        summary: 'Valid post with an unsupported event version.',
        posts: [{ roomId: 'review', text: 'DO_NOT_PROJECT_VERSION_2', mentions: [] }],
      },
    }, 2);
    const before = await readEvents(run.storage, run.runId);
    const directory = join(run.root, 'room-files');
    await mkdir(directory);
    await writeFile(join(directory, 'keep.txt'), 'keep this file');

    await expect(projectTeamRooms()({ storage: run.storage, runId: run.runId, directory }))
      .rejects.toMatchObject({ name: 'GraphExecutionError', code: 'INVALID_EVENT' });
    expect(await readdir(directory)).toEqual(['keep.txt']);
    expect(await readFile(join(directory, 'keep.txt'), 'utf8')).toBe('keep this file');
    expect(await readEvents(run.storage, run.runId)).toEqual(before);
  });
});
