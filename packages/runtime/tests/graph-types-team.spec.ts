import { describe, expect, it } from 'vitest';

import * as runtime from '../src/api.ts';
import { runGraphTypeConformance } from '../src/testing.ts';
import type { TeamGraphState } from '../src/graph-types/team.ts';
import type {
  CompiledGraphType,
  DispatchGraphCommand,
  GraphCommand,
  GraphDefinition,
  GraphEvent,
  GraphType,
  JsonObject,
  JsonValue,
} from '../src/api.ts';

type FixtureMember = {
  id: string;
  data: JsonObject & { role: string; brief: string; initialTurn?: boolean };
};

const definition = {
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
      data: { role: 'reviewer', brief: 'Check the draft.', initialTurn: false },
    },
  ] as FixtureMember[],
  edges: [],
};
const question = {
  summary: 'Draft ready for a check.',
  posts: [{ roomId: 'review', text: 'Please check the draft.', mentions: ['reviewer'] }],
};
const reply = {
  summary: 'The draft is accurate.',
  posts: [{ roomId: 'review', text: 'The draft is accurate.', mentions: ['writer'] }],
};

function compileTeam(input: GraphDefinition = definition): CompiledGraphType {
  // An absent proposed export must fail an assertion, not module loading.
  const form = (runtime as unknown as { teamGraphType?: GraphType }).teamGraphType;
  expect(form, 'The public runtime must expose the compiled team form.').toBeDefined();
  return runtime.compileGraph(form!, input);
}

function replay(compiled: CompiledGraphType, events: readonly GraphEvent[]): JsonValue {
  return events.reduce((state, event) => compiled.reduce(state, event), compiled.initialState());
}

function onlyDispatch(commands: readonly GraphCommand[], member: string): DispatchGraphCommand {
  expect(commands.map((command) => command.kind === 'dispatch' ? command.nodeId : command.kind))
    .toEqual([member]);
  return commands[0] as DispatchGraphCommand;
}

function dispatched(nodeId: string, position: string): GraphEvent {
  return { type: 'node-dispatched', version: 1, payload: { nodeId, position } };
}

function completed(nodeId: string, position: string, result: JsonObject): GraphEvent {
  return { type: 'node-completed', version: 1, payload: { nodeId, position, result } };
}

// The contract fixes message fields, but does not prescribe the input's containers.
function objects(value: JsonValue): JsonObject[] {
  if (Array.isArray(value)) return value.flatMap(objects);
  if (value === null || typeof value !== 'object') return [];
  return [value as JsonObject, ...Object.values(value).flatMap(objects)];
}

function messages(input: JsonValue): JsonObject[] {
  return objects(input).filter((value) => (
    typeof value.id === 'string'
    && typeof value.sender === 'string'
    && typeof value.position === 'string'
    && typeof value.roomId === 'string'
    && typeof value.text === 'string'
    && Array.isArray(value.mentions)
  ));
}

function expectRejectedTurn(compiled: CompiledGraphType, state: JsonValue, event: GraphEvent): void {
  const payload = event.payload as JsonObject;
  const before = state as TeamGraphState;
  const failed = compiled.reduce(state, event) as TeamGraphState;
  expect(failed.nodes[payload.nodeId as string]).toMatchObject({
    status: 'failed', failureCode: 'RESULT_INVALID', inFlight: null, pauseReason: null,
    result: before.nodes[payload.nodeId as string]!.result,
  });
  expect(failed.messages).toEqual(before.messages);
  expect(compiled.decide(failed)).toEqual([{
    kind: 'fail', code: 'TEAM_NODE_FAILED', message: `Failed team members: ${payload.nodeId}.`,
  }]);
  expect(compiled.validateNodeResult?.(payload.nodeId as string, payload.result!))
    .toMatchObject({ code: 'INVALID_TEAM' });
}

describe('compiled team graph', () => {
  it('conforms with literal writer, reviewer, writer event prefixes and bounds', () => {
    compileTeam();
    const idle = { status: 'idle', turns: 0, inFlight: null, pauseReason: null, failureCode: null, result: null, triggers: [] };
    const initialWriter = { ...idle, queued: true };
    const idleReviewer = { ...idle, queued: false };
    const writerActive = { ...initialWriter, queued: false, status: 'in-flight', turns: 1, inFlight: 'team/writer/1' };
    const savedQuestion = { ...question.posts[0]!, id: 'team/writer/1/0', sender: 'writer', position: 'team/writer/1' };
    const savedReply = { ...reply.posts[0]!, id: 'team/reviewer/1/0', sender: 'reviewer', position: 'team/reviewer/1' };
    const writerFinished = { ...initialWriter, queued: false, turns: 1, result: question };
    const reviewerQueued = { ...idleReviewer, queued: true, triggers: ['team/writer/1/0'] };
    const reviewerActive = { ...idleReviewer, status: 'in-flight', turns: 1, inFlight: 'team/reviewer/1' };
    const reviewerFinished = { ...idleReviewer, turns: 1, result: reply };
    const writerQueued = { ...writerFinished, queued: true, triggers: ['team/reviewer/1/0'] };
    const nextWriterActive = { ...writerFinished, status: 'in-flight', turns: 2, inFlight: 'team/writer/2' };
    const finalResult = { summary: 'Release note complete.' };
    const output = { task: definition.data.task, agents: [
      { name: 'writer', role: 'writer', result: finalResult },
      { name: 'reviewer', role: 'reviewer', result: reply },
    ] };
    const identity = { source: 'file:team-fixture', version: '1.0.0', digest: `sha256:${'4'.repeat(64)}` as const };
    const report = runGraphTypeConformance({
      graphType: (runtime as unknown as { teamGraphType: GraphType }).teamGraphType,
      definition,
      events: [
        dispatched('writer', 'team/writer/1'), completed('writer', 'team/writer/1', question),
        dispatched('reviewer', 'team/reviewer/1'), completed('reviewer', 'team/reviewer/1', reply),
        dispatched('writer', 'team/writer/2'), completed('writer', 'team/writer/2', finalResult),
      ],
      invalidDefinitions: [{ ...definition, edges: [{ id: 'dependency', source: 'writer', target: 'reviewer', data: {} }] }],
      planResolution: { package: identity, admission: { package: identity, permissions: [] }, executionLanes: [] },
      expected: {
        states: [
          { nodes: { writer: initialWriter, reviewer: idleReviewer }, messages: [] },
          { nodes: { writer: writerActive, reviewer: idleReviewer }, messages: [] },
          { nodes: { writer: writerFinished, reviewer: reviewerQueued }, messages: [savedQuestion] },
          { nodes: { writer: writerFinished, reviewer: reviewerActive }, messages: [savedQuestion] },
          { nodes: { writer: writerQueued, reviewer: reviewerFinished }, messages: [savedQuestion, savedReply] },
          { nodes: { writer: nextWriterActive, reviewer: reviewerFinished }, messages: [savedQuestion, savedReply] },
          { nodes: { writer: { ...writerFinished, turns: 2, result: finalResult }, reviewer: reviewerFinished }, messages: [savedQuestion, savedReply] },
        ],
        commands: [
          [{ kind: 'dispatch', nodeId: 'writer', position: 'team/writer/1', input: {
            task: definition.data.task, role: 'writer', brief: 'Draft the release note.', result: null, messages: [],
          } }], [],
          [{ kind: 'dispatch', nodeId: 'reviewer', position: 'team/reviewer/1', input: {
            task: definition.data.task, role: 'reviewer', brief: 'Check the draft.', result: null, messages: [savedQuestion],
          } }], [],
          [{ kind: 'dispatch', nodeId: 'writer', position: 'team/writer/2', input: {
            task: definition.data.task, role: 'writer', brief: 'Draft the release note.', result: question, messages: [savedQuestion, savedReply],
          } }], [], [{ kind: 'complete', output }],
        ],
        bounds: {
          dispatches: { min: { kind: 'known', value: 1 }, max: { kind: 'known', value: 4 } },
          maxConcurrency: { kind: 'known', value: 1 }, maxFanOut: { kind: 'known', value: 1 },
        },
      },
    });
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    const failedReport = runGraphTypeConformance({
      graphType: (runtime as unknown as { teamGraphType: GraphType }).teamGraphType,
      definition,
      events: [
        dispatched('writer', 'team/writer/1'), completed('writer', 'team/writer/1', question),
        dispatched('reviewer', 'team/reviewer/1'), completed('reviewer', 'team/reviewer/1', {
          summary: 'Reject the whole reply.', posts: [
            { roomId: 'review', text: 'Do not send.', mentions: ['writer'] },
            { roomId: 'review', text: 'Bad recipient.', mentions: ['stranger'] },
          ],
        }),
      ],
      invalidDefinitions: [{ ...definition, edges: [{ id: 'dependency', source: 'writer', target: 'reviewer', data: {} }] }],
      planResolution: { package: identity, admission: { package: identity, permissions: [] }, executionLanes: [] },
      expected: {
        states: [
          { nodes: { writer: initialWriter, reviewer: idleReviewer }, messages: [] },
          { nodes: { writer: writerActive, reviewer: idleReviewer }, messages: [] },
          { nodes: { writer: writerFinished, reviewer: reviewerQueued }, messages: [savedQuestion] },
          { nodes: { writer: writerFinished, reviewer: reviewerActive }, messages: [savedQuestion] },
          { nodes: {
            writer: writerFinished,
            reviewer: { ...idleReviewer, turns: 1, status: 'failed', failureCode: 'RESULT_INVALID' },
          }, messages: [savedQuestion] },
        ],
        commands: [
          [{ kind: 'dispatch', nodeId: 'writer', position: 'team/writer/1', input: {
            task: definition.data.task, role: 'writer', brief: 'Draft the release note.', result: null, messages: [],
          } }], [],
          [{ kind: 'dispatch', nodeId: 'reviewer', position: 'team/reviewer/1', input: {
            task: definition.data.task, role: 'reviewer', brief: 'Check the draft.', result: null, messages: [savedQuestion],
          } }], [],
          [{ kind: 'fail', code: 'TEAM_NODE_FAILED', message: 'Failed team members: reviewer.' }],
        ],
        bounds: {
          dispatches: { min: { kind: 'known', value: 1 }, max: { kind: 'known', value: 4 } },
          maxConcurrency: { kind: 'known', value: 1 }, maxFanOut: { kind: 'known', value: 1 },
        },
      },
    });
    expect(failedReport.failures).toEqual([]);
    expect(failedReport.ok).toBe(true);
  });

  it('queues a mention arriving during an active turn for a fresh later turn', () => {
    const input = structuredClone(definition);
    input.data.globalConcurrency = 2;
    delete input.nodes[1]!.data.initialTurn;
    const compiled = compileTeam(input);
    let state = replay(compiled, [
      dispatched('writer', 'team/writer/1'), dispatched('reviewer', 'team/reviewer/1'),
      completed('writer', 'team/writer/1', question),
      completed('reviewer', 'team/reviewer/1', { summary: 'Initial review done.' }),
    ]);
    const next = onlyDispatch(compiled.decide(state), 'reviewer');
    expect(next.position).toBe('team/reviewer/2');
    expect(messages(next.input).map((message) => message.text)).toEqual(['Please check the draft.']);
    state = compiled.reduce(state, dispatched('reviewer', next.position));
    state = compiled.reduce(state, completed('reviewer', next.position, { summary: 'Question answered.' }));
    expect(compiled.decide(state)[0]?.kind).toBe('complete');
  });

  it('waits for active work before pausing and resumes the same turn', () => {
    const input = structuredClone(definition);
    input.data.globalConcurrency = 2;
    delete input.nodes[1]!.data.initialTurn;
    const compiled = compileTeam(input);
    let state = replay(compiled, [
      dispatched('writer', 'team/writer/1'), dispatched('reviewer', 'team/reviewer/1'),
      { type: 'node-paused', version: 1, payload: { nodeId: 'writer', position: 'team/writer/1', reason: 'Approval needed.', request: null } },
    ]);
    expect(compiled.decide(state)).toEqual([]);
    state = compiled.reduce(state, completed('reviewer', 'team/reviewer/1', reply));
    expect(compiled.decide(state)).toEqual([{ kind: 'pause', reason: 'Approval needed.' }]);
    expect(compiled.reduce(state, completed('writer', 'team/writer/1', question))).toEqual(state);
    state = compiled.reduce(state, { type: 'node-resumed', version: 1, payload: { nodeId: 'writer', position: 'team/writer/1' } });
    expect(compiled.decide(state)).toEqual([]);
    state = compiled.reduce(state, completed('writer', 'team/writer/1', { summary: 'Approved.' }));
    expect(onlyDispatch(compiled.decide(state), 'writer').position).toBe('team/writer/2');
  });

  it.each(['failure first', 'pause first'])('reports a failed member after active work settles with %s, including replay', (order) => {
    const input = structuredClone(definition);
    input.data.globalConcurrency = 2;
    delete input.nodes[1]!.data.initialTurn;
    const compiled = compileTeam(input);
    const batch = compiled.decide(compiled.initialState());
    expect(batch.map((command) => command.kind === 'dispatch' ? command.nodeId : command.kind))
      .toEqual(['writer', 'reviewer']);
    const [writer, reviewer] = batch as readonly DispatchGraphCommand[];
    const dispatches = [
      dispatched('writer', writer!.position), dispatched('reviewer', reviewer!.position),
    ];
    const failure: GraphEvent = { type: 'node-failed', version: 1, payload: {
      nodeId: 'writer', position: writer!.position, code: 'ENGINE_UNAVAILABLE',
    } };
    const pause: GraphEvent = { type: 'node-paused', version: 1, payload: {
      nodeId: 'reviewer', position: reviewer!.position, reason: 'Approval needed.', request: null,
    } };
    const settlements = order === 'failure first' ? [failure, pause] : [pause, failure];
    let state = replay(compiled, [...dispatches, settlements[0]!]);
    expect(compiled.decide(state)).toEqual([]);
    state = compiled.reduce(state, settlements[1]!);
    const reopened = compileTeam(input);
    const replayed = replay(reopened, [...dispatches, ...settlements]);
    expect((replayed as TeamGraphState).nodes.writer?.failureCode).toBe('ENGINE_UNAVAILABLE');
    expect(replayed).toEqual(state);
    for (const commands of [compiled.decide(state), reopened.decide(replayed)]) {
      expect(commands).toEqual([{
        kind: 'fail', code: 'TEAM_NODE_FAILED', message: 'Failed team members: writer.',
      }]);
    }
  });

  it.each([null, [], 'answer', {}, { summary: 1 }, { summary: 'ok', posts: null },
    { summary: 'ok', posts: {} }, { summary: 'ok', posts: [null] },
    ...[{ roomId: 1 }, { text: 1 }, { mentions: 'reviewer' }, { mentions: [1] }].map((fields) => ({
      summary: 'ok', posts: [{ roomId: 'review', text: 'Check.', mentions: ['reviewer'], ...fields }],
    })),
  ].map((value) => [value as JsonValue]))('rejects malformed matching turn %j without changing saved state', (result) => {
    const compiled = compileTeam();
    const state = replay(compiled, [dispatched('writer', 'team/writer/1')]);
    const before = structuredClone(state);
    expectRejectedTurn(compiled, state, { type: 'node-completed', version: 1, payload: {
      nodeId: 'writer', position: 'team/writer/1', result,
    } });
    expect(state).toEqual(before);
    expect(compiled.reduce(state, { type: 'node-completed', version: 1, payload: {
      nodeId: 'writer', position: 'team/writer/0', result,
    } })).toEqual(before);
  });

  it.each(['', ' writer', 'writer ', 'writer\n', 'writer\u007f'])('rejects invalid member and room identifier %j', (id) => {
    const member = structuredClone(definition);
    member.nodes[0]!.id = id;
    expect(() => compileTeam(member)).toThrow(runtime.GraphValidationError);
    const room = structuredClone(definition);
    room.data.communication.rooms[0]!.id = id;
    expect(() => compileTeam(room)).toThrow(runtime.GraphValidationError);
  });

  it('rejects duplicate members, rooms, room memberships and an overflowing dispatch bound', () => {
    const member = structuredClone(definition);
    member.nodes.push(member.nodes[0]!);
    const room = structuredClone(definition);
    room.data.communication.rooms.push(room.data.communication.rooms[0]!);
    const membership = structuredClone(definition);
    membership.data.communication.rooms[0]!.members.push('writer');
    const overflow = structuredClone(definition);
    overflow.data.maxTurnsPerMember = Number.MAX_SAFE_INTEGER;
    for (const invalid of [member, room, membership, overflow]) {
      expect(() => compileTeam(invalid)).toThrow(runtime.GraphValidationError);
    }
  });

  it('delivers the saved question and reply through writer, reviewer, writer turns', () => {
    const compiled = compileTeam();
    let state = compiled.initialState();
    const firstWriter = onlyDispatch(compiled.decide(state), 'writer');
    state = compiled.reduce(state, dispatched('writer', firstWriter.position));
    expect(compiled.decide(state)).toEqual([]);
    state = compiled.reduce(state, completed('writer', firstWriter.position, question));

    const reviewer = onlyDispatch(compiled.decide(state), 'reviewer');
    expect(messages(reviewer.input)).toEqual([{
      id: expect.any(String), sender: 'writer', position: firstWriter.position,
      roomId: 'review', text: 'Please check the draft.', mentions: ['reviewer'],
    }]);
    expect(JSON.stringify(reviewer.input)).toContain('Prepare a release note.');
    expect(JSON.stringify(reviewer.input)).toContain('Check the draft.');
    state = compiled.reduce(state, dispatched('reviewer', reviewer.position));
    expect(compiled.decide(state)).toEqual([]);
    state = compiled.reduce(state, completed('reviewer', reviewer.position, reply));

    const secondWriter = onlyDispatch(compiled.decide(state), 'writer');
    expect(secondWriter.position).not.toBe(firstWriter.position);
    expect(messages(secondWriter.input)).toEqual([
      {
        id: expect.any(String), sender: 'writer', position: firstWriter.position,
        roomId: 'review', text: 'Please check the draft.', mentions: ['reviewer'],
      },
      {
        id: expect.any(String), sender: 'reviewer', position: reviewer.position,
        roomId: 'review', text: 'The draft is accurate.', mentions: ['writer'],
      },
    ]);
    expect(objects(secondWriter.input)).toContainEqual(question);
    state = compiled.reduce(state, dispatched('writer', secondWriter.position));
    expect(compiled.decide(state)).toEqual([]);
    state = compiled.reduce(state, completed('writer', secondWriter.position, {
      summary: 'Release note complete.',
    }));
    expect(compiled.decide(state)).toEqual([{
      kind: 'complete',
      output: {
        task: 'Prepare a release note.',
        agents: [
          { name: 'writer', role: 'writer', result: { summary: 'Release note complete.' } },
          {
            name: 'reviewer', role: 'reviewer',
            result: {
              summary: 'The draft is accurate.',
              posts: [{ roomId: 'review', text: 'The draft is accurate.', mentions: ['writer'] }],
            },
          },
        ],
      },
    }]);
  });

  it('gives every member an initial turn when initialTurn is omitted', () => {
    const input = structuredClone(definition);
    delete input.nodes[1]!.data.initialTurn;
    const compiled = compileTeam(input);
    const writer = onlyDispatch(compiled.decide(compiled.initialState()), 'writer');
    const state = replay(compiled, [
      dispatched('writer', writer.position),
      completed('writer', writer.position, { summary: 'Draft complete.' }),
    ]);
    onlyDispatch(compiled.decide(state), 'reviewer');
  });

  it('returns null for a member left idle by initialTurn false', () => {
    const compiled = compileTeam();
    const writer = onlyDispatch(compiled.decide(compiled.initialState()), 'writer');
    const state = replay(compiled, [
      dispatched('writer', writer.position),
      completed('writer', writer.position, { summary: 'No review needed.' }),
    ]);
    expect(compiled.decide(state)).toEqual([{
      kind: 'complete',
      output: {
        task: 'Prepare a release note.',
        agents: [
          { name: 'writer', role: 'writer', result: { summary: 'No review needed.' } },
          { name: 'reviewer', role: 'reviewer', result: null },
        ],
      },
    }]);
  });

  it('combines pending mentions into one turn without losing a trigger older than the room tail', () => {
    const input = structuredClone(definition);
    input.data.communication.tailMessages = 1;
    const compiled = compileTeam(input);
    const writer = onlyDispatch(compiled.decide(compiled.initialState()), 'writer');
    let state = replay(compiled, [
      dispatched('writer', writer.position),
      completed('writer', writer.position, {
        summary: 'Two checks needed.',
        posts: [
          { roomId: 'review', text: 'Check the title.', mentions: ['reviewer'] },
          { roomId: 'review', text: 'Check the body.', mentions: ['reviewer'] },
        ],
      }),
    ]);
    const reviewer = onlyDispatch(compiled.decide(state), 'reviewer');
    expect(messages(reviewer.input)).toEqual([
      {
        id: expect.any(String), sender: 'writer', position: writer.position,
        roomId: 'review', text: 'Check the title.', mentions: ['reviewer'],
      },
      {
        id: expect.any(String), sender: 'writer', position: writer.position,
        roomId: 'review', text: 'Check the body.', mentions: ['reviewer'],
      },
    ]);
    const saved = messages(reviewer.input);
    expect(saved[0]!.id).not.toBe(saved[1]!.id);
    state = compiled.reduce(state, dispatched('reviewer', reviewer.position));
    state = compiled.reduce(state, completed('reviewer', reviewer.position, { summary: 'Both checked.' }));
    expect(compiled.decide(state).map((command) => command.kind)).toEqual(['complete']);
  });

  it('waits for the whole recorded batch even when a concurrency slot becomes free', () => {
    const input = structuredClone(definition);
    input.data.globalConcurrency = 2;
    delete input.nodes[1]!.data.initialTurn;
    input.nodes.push({ id: 'observer', data: { role: 'observer', brief: 'Watch the release.' } });
    const compiled = compileTeam(input);
    const batch = compiled.decide(compiled.initialState());
    expect(batch.map((command) => command.kind === 'dispatch' ? command.nodeId : command.kind))
      .toEqual(['writer', 'reviewer']);
    const [writer, reviewer] = batch as readonly DispatchGraphCommand[];
    const state = replay(compiled, [
      dispatched('writer', writer!.position),
      dispatched('reviewer', reviewer!.position),
      completed('writer', writer!.position, question),
    ]);
    expect(compiled.decide(state)).toEqual([]);
  });

  it('keeps private room text and another member result out of an outsider input', () => {
    const input = structuredClone(definition);
    input.nodes.push({ id: 'observer', data: { role: 'observer', brief: 'Watch the release.' } });
    const compiled = compileTeam(input);
    const writer = onlyDispatch(compiled.decide(compiled.initialState()), 'writer');
    const state = replay(compiled, [
      dispatched('writer', writer.position),
      completed('writer', writer.position, {
        summary: 'PRIVATE_RESULT_713',
        posts: [{ roomId: 'review', text: 'PRIVATE_MESSAGE_924', mentions: [] }],
      }),
    ]);
    const observer = onlyDispatch(compiled.decide(state), 'observer');
    expect(JSON.stringify(observer.input)).toContain('Watch the release.');
    expect(JSON.stringify(observer.input)).not.toContain('PRIVATE_MESSAGE_924');
    expect(JSON.stringify(observer.input)).not.toContain('PRIVATE_RESULT_713');
    expect(messages(observer.input)).toEqual([]);
  });

  it('rejects a room whose membership names an undeclared member', () => {
    const input = structuredClone(definition);
    input.data.communication.rooms[0]!.members.push('stranger');
    expect(() => compileTeam(input)).toThrow(runtime.GraphValidationError);
  });

  it.each([
    {
      name: 'a sender outside the room',
      members: ['reviewer'],
      post: { roomId: 'private', text: 'Not permitted.', mentions: ['reviewer'] },
    },
    {
      name: 'a mention outside the room',
      members: ['writer'],
      post: { roomId: 'private', text: 'Not permitted.', mentions: ['reviewer'] },
    },
    {
      name: 'a mention naming an undeclared member',
      members: ['writer'],
      post: { roomId: 'private', text: 'Not permitted.', mentions: ['stranger'] },
    },
  ])('rejects the whole recorded turn with $name before delivering its valid first post', ({ members, post }) => {
    const input = structuredClone(definition);
    input.data.communication.rooms.push({ id: 'private', members });
    const compiled = compileTeam(input);
    const writer = onlyDispatch(compiled.decide(compiled.initialState()), 'writer');
    const state = compiled.reduce(compiled.initialState(), dispatched('writer', writer.position));
    expectRejectedTurn(compiled, state, completed('writer', writer.position, {
      summary: 'Must reject both posts.',
      posts: [
        { roomId: 'review', text: 'Do not deliver a partial turn.', mentions: ['reviewer'] },
        post,
      ],
    }));
  });

  it('freezes room membership against later edits to caller-owned arrays', () => {
    const input = structuredClone(definition);
    input.nodes.push({ id: 'observer', data: { role: 'observer', brief: 'Watch the release.' } });
    const compiled = compileTeam(input);
    input.data.communication.rooms[0]!.members.push('observer');
    input.data.communication.rooms.push({ id: 'added-later', members: ['writer', 'observer'] });
    expect((compiled.definition.value.data as JsonObject).communication).toEqual({
      rooms: [{ id: 'review', members: ['writer', 'reviewer'] }], tailMessages: 3,
    });
    const writer = onlyDispatch(compiled.decide(compiled.initialState()), 'writer');
    const inFlight = compiled.reduce(compiled.initialState(), dispatched('writer', writer.position));
    const state = compiled.reduce(inFlight, completed('writer', writer.position, {
      summary: 'Private draft.',
      posts: [{ roomId: 'review', text: 'FROZEN_PRIVATE_617', mentions: [] }],
    }));
    const observer = onlyDispatch(compiled.decide(state), 'observer');
    expect(JSON.stringify(observer.input)).not.toContain('FROZEN_PRIVATE_617');
    expectRejectedTurn(compiled, inFlight, completed('writer', writer.position, {
      summary: 'Caller mutation must not grant access.',
      posts: [{ roomId: 'review', text: 'Forbidden mention.', mentions: ['observer'] }],
    }));
  });

  it('delivers nothing from a completion that arrives after the matching attempt failed', () => {
    const compiled = compileTeam();
    const writer = onlyDispatch(compiled.decide(compiled.initialState()), 'writer');
    const failed = replay(compiled, [
      dispatched('writer', writer.position),
      { type: 'node-failed', version: 1, payload: {
        nodeId: 'writer', position: writer.position, code: 'ENGINE_UNAVAILABLE',
      } },
    ]);
    const late = compiled.reduce(failed, completed('writer', writer.position, question));
    expect(late).toEqual(failed);
    expect(compiled.decide(late)).toEqual([{
      kind: 'fail', code: expect.any(String), message: expect.any(String),
    }]);
  });

  it('ignores a stale completion while the writer has a newer turn in flight', () => {
    const compiled = compileTeam();
    const writer = onlyDispatch(compiled.decide(compiled.initialState()), 'writer');
    let state = replay(compiled, [
      dispatched('writer', writer.position), completed('writer', writer.position, question),
    ]);
    const reviewer = onlyDispatch(compiled.decide(state), 'reviewer');
    state = compiled.reduce(state, dispatched('reviewer', reviewer.position));
    state = compiled.reduce(state, completed('reviewer', reviewer.position, reply));
    const nextWriter = onlyDispatch(compiled.decide(state), 'writer');
    state = compiled.reduce(state, dispatched('writer', nextWriter.position));
    const stale = compiled.reduce(state, completed('writer', writer.position, {
      summary: 'Stale answer.',
      posts: [{ roomId: 'review', text: 'STALE_POST_481', mentions: ['reviewer'] }],
    }));
    expect(stale).toEqual(state);
    expect(compiled.decide(stale)).toEqual([]);
    expectRejectedTurn(compiled, stale, completed('writer', nextWriter.position, {
      summary: 'Bad second turn.',
      posts: [{ roomId: 'review', text: 'Do not save.', mentions: ['stranger'] }],
    }));
    state = compiled.reduce(stale, completed('writer', nextWriter.position, { summary: 'Finished.' }));
    expect(compiled.decide(state).map((command) => command.kind)).toEqual(['complete']);
  });

  it('replays a saved question into the same single next turn and ignores duplicate completion', () => {
    const compiled = compileTeam();
    const writer = onlyDispatch(compiled.decide(compiled.initialState()), 'writer');
    const events = [
      dispatched('writer', writer.position), completed('writer', writer.position, question),
    ];
    const first = onlyDispatch(compiled.decide(replay(compiled, events)), 'reviewer');
    const fresh = compileTeam();
    let state = replay(fresh, events);
    const second = onlyDispatch(fresh.decide(state), 'reviewer');
    expect(second.position).toBe(first.position);
    expect(messages(second.input)).toEqual([{
      id: expect.any(String), sender: 'writer', position: writer.position,
      roomId: 'review', text: 'Please check the draft.', mentions: ['reviewer'],
    }]);
    expect(messages(second.input)[0]!.id).toBe(messages(first.input)[0]!.id);
    state = fresh.reduce(state, events[1]!);
    expect(fresh.decide(state)).toEqual([second]);
    state = fresh.reduce(state, dispatched('reviewer', second.position));
    state = fresh.reduce(state, completed('reviewer', second.position, { summary: 'Approved.' }));
    state = fresh.reduce(state, events[1]!);
    expect(fresh.decide(state).map((command) => command.kind)).toEqual(['complete']);
    const replayed = replay(compileTeam(), [
      ...events, dispatched('reviewer', second.position),
      completed('reviewer', second.position, { summary: 'Approved.' }),
    ]);
    expect(fresh.decide(replayed).map((command) => command.kind)).toEqual(['complete']);
  });

  it('fails with TEAM_TURN_LIMIT when a reply requests a third writer turn', () => {
    const compiled = compileTeam();
    let state = compiled.initialState();
    for (const member of ['writer', 'reviewer', 'writer', 'reviewer']) {
      const turn = onlyDispatch(compiled.decide(state), member);
      state = compiled.reduce(state, dispatched(member, turn.position));
      state = compiled.reduce(state, completed(member, turn.position, member === 'writer' ? question : reply));
    }
    expect(compiled.decide(state)).toEqual([{
      kind: 'fail', code: 'TEAM_TURN_LIMIT', message: expect.any(String),
    }]);
    expect(compiled.describe().bounds.dispatches.max).toEqual({ kind: 'known', value: 4 });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid numeric bound %s before dispatch', (limit) => {
    for (const field of ['globalConcurrency', 'maxTurnsPerMember', 'tailMessages'] as const) {
      const input = structuredClone(definition);
      if (field === 'tailMessages') input.data.communication.tailMessages = limit;
      else input.data[field] = limit;
      expect(() => compileTeam(input), field).toThrow(runtime.GraphValidationError);
    }
  });

  it('rejects posts when communication is omitted', () => {
    const compiled = compileTeam({
      ...definition,
      data: { task: 'Prepare a release note.', globalConcurrency: 1, maxTurnsPerMember: 2 },
    });
    const writer = onlyDispatch(compiled.decide(compiled.initialState()), 'writer');
    const state = compiled.reduce(compiled.initialState(), dispatched('writer', writer.position));
    expectRejectedTurn(compiled, state, completed('writer', writer.position, question));
  });
});
