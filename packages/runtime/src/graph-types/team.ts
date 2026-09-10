import { isDeepStrictEqual } from 'node:util';

import type { GraphCommand } from '../graph/commands.js';
import type { GraphDefinition } from '../graph/kernel.js';
import type { ExecutionLaneDescription, GraphDescriptionInput } from '../graph/plan.js';
import type { GraphEvent, GraphType } from '../graph/type.js';
import { GraphValidationError, type JsonObject, type JsonValue } from '../graph/value.js';

export type TeamNodeData = JsonObject & {
  role: string;
  brief: string;
  initialTurn?: boolean;
  lane?: ExecutionLaneDescription;
};

export interface TeamRoom extends JsonObject {
  id: string;
  members: readonly string[];
}

export interface TeamCommunication extends JsonObject {
  rooms: readonly TeamRoom[];
  tailMessages: number;
}

export type TeamGraphData = JsonObject & {
  task: string;
  globalConcurrency: number;
  maxTurnsPerMember: number;
  communication?: TeamCommunication;
};

export type TeamDefinition = GraphDefinition<TeamNodeData, JsonObject, TeamGraphData>;

export interface TeamPost extends JsonObject {
  roomId: string;
  text: string;
  mentions: readonly string[];
}

export type TeamTurnResult = JsonObject & {
  summary: string;
  data?: JsonValue;
  posts?: readonly TeamPost[];
};

export interface TeamMessage extends TeamPost {
  id: string;
  sender: string;
  position: string;
}

export interface TeamGraphResult extends JsonObject {
  task: string;
  agents: readonly { name: string; role: string; result: TeamTurnResult | null }[];
}

interface TeamMemberState extends JsonObject {
  readonly status: 'idle' | 'in-flight' | 'paused' | 'failed';
  readonly turns: number;
  readonly inFlight: string | null;
  readonly pauseReason: string | null;
  readonly result: TeamTurnResult | null;
  readonly queued: boolean;
  readonly triggers: readonly string[];
}

/** Saved messages are the accepted record for host room projections. */
export interface TeamGraphState extends JsonObject {
  readonly nodes: Readonly<Record<string, TeamMemberState>>;
  readonly messages: readonly TeamMessage[];
}

function fail(path: string, message: string): never {
  throw new GraphValidationError('Invalid team graph.', [{ code: 'INVALID_TEAM', path, message }]);
}

function record(value: unknown, path: string): asserts value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'Expected an object.');
  }
}

function text(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string') fail(path, 'Expected text.');
}

function identifier(value: unknown, path: string): asserts value is string {
  text(value, path);
  if (!value.length || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(path, 'Expected a nonempty trimmed name without control characters.');
  }
}

function limit(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(path, 'Expected a positive safe integer.');
  }
}

function validateTeam(definition: TeamDefinition): void {
  record(definition.data, '/data');
  text(definition.data.task, '/data/task');
  limit(definition.data.globalConcurrency, '/data/globalConcurrency');
  limit(definition.data.maxTurnsPerMember, '/data/maxTurnsPerMember');
  if (!Number.isSafeInteger(definition.nodes.length * definition.data.maxTurnsPerMember)) {
    fail('/data/maxTurnsPerMember', 'The total dispatch bound must be a safe integer.');
  }
  if (definition.edges.length) fail('/edges', 'Team turns are requested by messages; edges must be empty.');
  const members = new Set(definition.nodes.map((node) => node.id));
  const lanes = new Map<string, ExecutionLaneDescription>();
  for (const node of definition.nodes) {
    const path = `/nodes/${node.id}/data`;
    record(node.data, path);
    text(node.data.role, `${path}/role`);
    text(node.data.brief, `${path}/brief`);
    if (node.data.initialTurn !== undefined && typeof node.data.initialTurn !== 'boolean') {
      fail(`${path}/initialTurn`, 'Expected a boolean.');
    }
    if (node.data.lane !== undefined) {
      record(node.data.lane, `${path}/lane`);
      const declared = lanes.get(node.data.lane.id);
      if (declared !== undefined && !isDeepStrictEqual(declared, node.data.lane)) {
        fail(`${path}/lane`, 'Members sharing a lane must use the same declaration.');
      }
      lanes.set(node.data.lane.id, node.data.lane);
    }
  }
  const communication = definition.data.communication;
  if (communication === undefined) return;
  record(communication, '/data/communication');
  limit(communication.tailMessages, '/data/communication/tailMessages');
  if (!Array.isArray(communication.rooms)) fail('/data/communication/rooms', 'Expected a room list.');
  const rooms = new Set<string>();
  for (const [index, room] of communication.rooms.entries()) {
    const path = `/data/communication/rooms/${index}`;
    record(room, path);
    identifier(room.id, `${path}/id`);
    if (rooms.has(room.id)) fail(`${path}/id`, 'Room IDs must be unique.');
    rooms.add(room.id);
    if (!Array.isArray(room.members)) fail(`${path}/members`, 'Expected a member list.');
    const seen = new Set<string>();
    for (const member of room.members) {
      identifier(member, `${path}/members`);
      if (!members.has(member) || seen.has(member)) {
        fail(`${path}/members`, 'Room members must be distinct declared node IDs.');
      }
      seen.add(member);
    }
  }
}

function validateResult(
  value: unknown,
  sender: string,
  rooms: ReadonlyMap<string, TeamRoom>,
  communication: boolean,
): asserts value is TeamTurnResult {
  const path = '/event/payload/result';
  record(value, path);
  text(value.summary, `${path}/summary`);
  if (value.posts === undefined) return;
  if (!communication || !Array.isArray(value.posts)) {
    fail(`${path}/posts`, 'Posts require communication and a post list.');
  }
  for (const [index, post] of value.posts.entries()) {
    const postPath = `${path}/posts/${index}`;
    record(post, postPath);
    identifier(post.roomId, `${postPath}/roomId`);
    text(post.text, `${postPath}/text`);
    const room = rooms.get(post.roomId);
    if (!room?.members.includes(sender)) fail(postPath, 'The sender must belong to the declared room.');
    if (!Array.isArray(post.mentions)) fail(`${postPath}/mentions`, 'Expected a mention list.');
    for (const mention of post.mentions) {
      if (typeof mention !== 'string' || !room.members.includes(mention)) {
        fail(`${postPath}/mentions`, 'Every mention must name a member of the room.');
      }
    }
  }
}

/** Pure member turns; only matching saved completions deliver posts. */
export const teamGraphType: GraphType<
  TeamDefinition,
  TeamGraphState,
  GraphEvent,
  { readonly memory: 'unused' }
> = {
  kind: 'team',
  version: 1,
  compile(definition) {
    validateTeam(definition);
    const { task, globalConcurrency, maxTurnsPerMember, communication } = definition.data;
    const rooms = new Map((communication?.rooms ?? []).map((room) => [room.id, room]));
    const positionFor = (id: string, node: TeamMemberState): string => `team/${id}/${node.turns + 1}`;
    return {
      requirements: { memory: 'unused' },
      initialState: () => ({
        nodes: Object.fromEntries(definition.nodes.map((node) => [node.id, {
          status: 'idle', turns: 0, inFlight: null, pauseReason: null, result: null,
          queued: node.data.initialTurn !== false, triggers: [],
        }])),
        messages: [],
      }),
      reduce(state, event) {
        const payload = event.payload;
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return state;
        const { nodeId, position } = payload as JsonObject;
        if (typeof nodeId !== 'string' || !Object.hasOwn(state.nodes, nodeId)) return state;
        const node = state.nodes[nodeId]!;
        const update = (next: TeamMemberState): TeamGraphState => ({
          ...state,
          nodes: { ...state.nodes, [nodeId]: next },
        });
        if (event.type === 'node-dispatched') {
          if (node.status !== 'idle' || !node.queued
            || node.turns >= maxTurnsPerMember
            || position !== positionFor(nodeId, node)) return state;
          return update({
            ...node,
            status: 'in-flight',
            turns: node.turns + 1,
            inFlight: position,
            queued: false,
            triggers: [],
            pauseReason: null,
          });
        }
        if (node.inFlight !== position) return state;
        if (event.type === 'node-resumed' && node.status === 'paused') {
          return update({ ...node, status: 'in-flight', pauseReason: null });
        }
        if (node.status !== 'in-flight') return state;
        if (event.type === 'node-paused') {
          text((payload as JsonObject).reason, '/event/payload/reason');
          return update({
            ...node,
            status: 'paused',
            pauseReason: (payload as JsonObject).reason as string,
          });
        }
        if (event.type === 'node-failed') {
          return update({ ...node, status: 'failed', inFlight: null, pauseReason: null });
        }
        if (event.type !== 'node-completed') return state;
        const result = (payload as JsonObject).result;
        validateResult(result, nodeId, rooms, communication !== undefined);
        const messages: TeamMessage[] = (result.posts ?? []).map((post, index) => ({
          roomId: post.roomId, text: post.text, mentions: post.mentions,
          id: `${position}/${index}`, sender: nodeId, position: position as string,
        }));
        const nodes = {
          ...state.nodes,
          [nodeId]: { ...node, status: 'idle' as const, inFlight: null, pauseReason: null, result },
        };
        for (const message of messages) {
          for (const recipient of new Set(message.mentions)) {
            const member = nodes[recipient]!;
            nodes[recipient] = { ...member, queued: true, triggers: [...member.triggers, message.id] };
          }
        }
        return { nodes, messages: [...state.messages, ...messages] };
      },
      decide(state) {
        if (Object.values(state.nodes).some((node) => node.status === 'in-flight')) return [];
        const paused = definition.nodes.find((node) => state.nodes[node.id]!.status === 'paused');
        if (paused) return [{ kind: 'pause', reason: state.nodes[paused.id]!.pauseReason! }];
        const failed = definition.nodes.filter((node) => state.nodes[node.id]!.status === 'failed');
        if (failed.length) return [{
          kind: 'fail',
          code: 'TEAM_NODE_FAILED',
          message: `Failed team members: ${failed.map((node) => node.id).join(', ')}.`,
        }];
        const queued = definition.nodes.filter((node) => state.nodes[node.id]!.queued);
        const exhausted = queued.find((node) => state.nodes[node.id]!.turns >= maxTurnsPerMember);
        if (exhausted) return [{
          kind: 'fail',
          code: 'TEAM_TURN_LIMIT',
          message: `Member "${exhausted.id}" reached maxTurnsPerMember.`,
        }];
        if (queued.length) return queued.slice(0, globalConcurrency).map((member): GraphCommand => {
          const node = state.nodes[member.id]!;
          const visible = new Set(node.triggers);
          for (const room of rooms.values()) {
            if (!room.members.includes(member.id)) continue;
            for (const message of state.messages.filter((message) => message.roomId === room.id).slice(-communication!.tailMessages)) {
              visible.add(message.id);
            }
          }
          return {
            kind: 'dispatch',
            nodeId: member.id,
            position: positionFor(member.id, node),
            input: {
              task,
              role: member.data.role,
              brief: member.data.brief,
              result: node.result,
              messages: state.messages.filter((message) => visible.has(message.id)),
            },
          };
        });
        const output: TeamGraphResult = {
          task,
          agents: definition.nodes.map((node) => ({
            name: node.id, role: node.data.role, result: state.nodes[node.id]!.result,
          })),
        };
        return [{ kind: 'complete', output }];
      },
      describe(): GraphDescriptionInput {
        return {
          inputContract: { task: 'string' },
          outputContract: { task: 'string', agents: 'array' },
          phases: [{ id: 'team', name: 'Team', nodeIds: definition.nodes.map((node) => node.id) }],
          nodes: definition.nodes.map((node) => ({
            id: node.id,
            phaseId: 'team',
            inputContract: { task: 'string', role: 'string', brief: 'string', result: 'json', messages: 'array' },
            outputContract: { summary: 'string', data: 'json?', posts: 'array?' },
            laneId: node.data.lane?.id ?? null,
          })),
          policies: {
            retry: null,
            stop: { maxTurnsPerMember },
            concurrency: { global: globalConcurrency },
            write: null,
            budget: null,
            action: null,
          },
          executionLanes: [...new Map(definition.nodes.flatMap((node) =>
            node.data.lane ? [[node.data.lane.id, node.data.lane] as const] : [],
          )).values()],
          requestedPermissions: [],
          bounds: {
            dispatches: {
              min: { kind: 'known', value: definition.nodes.filter((node) => node.data.initialTurn !== false).length },
              max: { kind: 'known', value: definition.nodes.length * maxTurnsPerMember },
            },
            maxConcurrency: { kind: 'known', value: globalConcurrency },
            maxFanOut: { kind: 'known', value: globalConcurrency },
          },
        };
      },
    };
  },
};
