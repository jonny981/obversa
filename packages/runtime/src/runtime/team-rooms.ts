import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { join, resolve } from 'node:path';

import { compileGraph } from '../graph/type.js';
import {
  teamGraphType,
  type TeamDefinition,
  type TeamGraphState,
  type TeamMessage,
} from '../graph-types/team.js';
import { GraphExecutionError, validateStandardEvent } from './graph-executor.js';
import {
  loadRunDefinition,
  type RunStorageBinding,
  type RunStorageRecord,
} from './run-definition.js';
import type { StreamRevision } from '../events/envelope.js';

const GRAPH_PREFIX = 'graph:';
const STANDARD_EVENT_TYPES = new Set([
  'node-dispatched',
  'node-completed',
  'node-failed',
  'node-paused',
  'node-resumed',
]);

function mismatch(): never {
  throw new GraphExecutionError(
    'STORED_GRAPH_MISMATCH',
    'The stored graph is not the supported team graph.',
  );
}

function escapeLineValue(value: string): string {
  return value.replace(
    /[\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu,
    (character) => {
      if (character === '\\') return '\\\\';
      if (character === '\n') return '\\n';
      if (character === '\r') return '\\r';
      if (character === '\t') return '\\t';
      return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
    },
  );
}

function renderMessage(message: TeamMessage): string {
  const mentions = message.mentions.map((mention) => `@${escapeLineValue(mention)}`).join(' ');
  return `${escapeLineValue(message.sender)} [${escapeLineValue(message.id)}]${mentions ? ` ${mentions}` : ''}: ${escapeLineValue(message.text)}\n`;
}

function roomFilename(storage: RunStorageRecord, runId: string, roomId: string): string {
  const { name, version, configDigest } = storage.eventStore;
  const identity = JSON.stringify([name, version, configDigest, storage.namespace, runId, roomId]);
  const digest = createHash('sha256').update(identity).digest('hex');
  return `obversa-team-room-${digest}.txt`;
}

async function replaceFile(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(content, { encoding: 'utf8' });
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function projectTeamRooms(input: {
  readonly storage: RunStorageBinding;
  readonly runId: string;
  readonly directory: string;
}): Promise<{
  readonly revision: StreamRevision;
  readonly files: readonly { readonly roomId: string; readonly path: string }[];
}> {
  if (typeof input.directory !== 'string' || input.directory.trim().length === 0) {
    throw new TypeError('Projection directory must be a non-empty path.');
  }
  const directory = resolve(input.directory);
  const loaded = await loadRunDefinition(input.storage, input.runId);
  const storedGraph = loaded.resolvedPlan.plan.graph;
  if (
    storedGraph.kind !== teamGraphType.kind
    || storedGraph.typeVersion !== teamGraphType.version
  ) mismatch();

  const compiled = compileGraph(
    teamGraphType,
    loaded.record.payload.definition.graphDefinition.value as TeamDefinition,
  );
  if (!isDeepStrictEqual(storedGraph, compiled.describe().graph)) mismatch();

  const nodeIds = new Set(compiled.definition.value.nodes.map((node) => node.id));
  let state: TeamGraphState = compiled.initialState();
  let revision = 0;
  for await (const event of input.storage.eventStore.read({
    namespace: input.storage.record.namespace,
    streamId: input.runId,
  })) {
    revision = event.revision;
    if (!event.type.startsWith(GRAPH_PREFIX)) continue;
    const type = event.type.slice(GRAPH_PREFIX.length);
    if (type === 'run-started') continue;
    state = compiled.reduce(
      state,
      STANDARD_EVENT_TYPES.has(type)
        ? validateStandardEvent(event, type, nodeIds)
        : { type, version: event.version, payload: event.payload },
    );
  }

  const rooms = compiled.definition.value.data.communication?.rooms ?? [];
  const files = rooms.map((room) => ({
    roomId: room.id,
    path: join(directory, roomFilename(loaded.record.payload.definition.storage, input.runId, room.id)),
    content: state.messages
      .filter((message) => message.roomId === room.id)
      .map(renderMessage)
      .join(''),
  }));
  if (files.length === 0) return { revision, files: [] };

  await mkdir(directory, { recursive: true });
  for (const file of files) await replaceFile(file.path, file.content);
  return {
    revision,
    files: files.map(({ roomId, path }) => ({ roomId, path })),
  };
}
