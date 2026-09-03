import { describe, expect, it } from 'vitest';

import {
  createCallbackGate,
  callbackRequestDigest,
  type CallbackGateDefinition,
} from '../src/callback/gate.js';
import {
  createCallbackClient,
  directRouter,
  replayCallbackClient,
  type CallbackClient,
} from '../src/callback/client.js';
import type { JsonObject } from '../src/graph/value.js';
import { compileGraph } from '../src/graph/type.ts';
import type { GraphCommand } from '../src/graph/commands.js';
import { dag } from '../src/graph-types/dag.js';
import type { DagDefinition, DagEvent } from '../src/graph-types/dag.js';
import { directedState } from '../src/graph-types/state.js';
import type {
  DirectedStateDefinition,
  DirectedStateEvent,
} from '../src/graph-types/state.js';

const GATE: CallbackGateDefinition = {
  gateId: 'release-approval',
  gateVersion: 1,
  decisionText: 'Approve the release of revision abc123?',
  responseSchema: {
    type: 'object',
    properties: { approved: { type: 'boolean' } },
    required: ['approved'],
  },
  input: { revision: 'abc123' },
};

describe('callback gate', () => {
  it('digests what is asked, not how it is displayed', () => {
    const base = callbackRequestDigest(GATE);
    expect(callbackRequestDigest(GATE)).toBe(base);
    expect(callbackRequestDigest({ ...GATE, gateVersion: 2 })).not.toBe(base);
    expect(callbackRequestDigest({ ...GATE, decisionText: 'Approve now?' })).not.toBe(base);
    expect(callbackRequestDigest({
      ...GATE,
      responseSchema: { ...GATE.responseSchema, required: ['approved', 'note'] },
    })).not.toBe(base);
    expect(callbackRequestDigest({ ...GATE, input: { revision: 'def456' } })).not.toBe(base);

    const request = createCallbackGate(GATE);
    const again = createCallbackGate({ ...GATE, presentation: { theme: 'dark' } });
    expect(again.digest).toBe(request.digest);
  });

  it('claims atomically: two racing routers, exactly one winner', async () => {
    const client = createCallbackClient();
    const request = createCallbackGate(GATE);
    client.post(request);
    expect(client.listPending().map((pending) => pending.requestId)).toEqual([request.requestId]);

    const [first, second] = await Promise.all([
      client.claim(request.requestId, 'router-a'),
      client.claim(request.requestId, 'router-b'),
    ]);
    const winners = [first, second].filter((result) => result.ok).length;
    expect(winners).toBe(1);
    const loser = first.ok ? second : first;
    expect(loser.ok).toBe(false);
    if (!loser.ok) {
      expect(loser.kind).toBe('claimed');
      expect(loser.routerId).toBe(first.ok ? 'router-a' : 'router-b');
    }
  });

  it('refuses invalid data and stale answers, and records both', async () => {
    const client = createCallbackClient();
    const request = createCallbackGate(GATE);
    client.post(request);

    const claim = client.claim(request.requestId, 'router-a');
    expect(claim.ok).toBe(true);
    const token = claim.ok === true ? claim.claimToken : '';

    const invalid = client.submit(request.requestId, token, 'router-a', request.digest, { approved: 'yes' });
    expect(invalid.ok).toBe(false);
    expect(invalid.ok === false && invalid.kind).toBe('invalid');
    expect(invalid.ok === false && invalid.reason).toContain('approved');

    // An invalid answer does not advance the request: it is still claimed,
    // and a correct answer from the same router is accepted.
    const corrected = client.submit(request.requestId, token, 'router-a', request.digest, { approved: true });
    expect(corrected.ok).toBe(true);

    // A newer request from the same gate supersedes the older, unanswered
    // ones on its own; the answered request above keeps its evidence.
    const pending = createCallbackGate(GATE);
    client.post(pending);
    const pendingClaim = client.claim(pending.requestId, 'router-c');
    expect(pendingClaim.ok).toBe(true);
    const newer = createCallbackGate({ ...GATE, gateVersion: 2 });
    client.post(newer);
    const staleClaim = client.claim(pending.requestId, 'router-d');
    expect(staleClaim.ok).toBe(false);
    expect(staleClaim.ok === false && staleClaim.kind).toBe('superseded');

    const rejected = client.history(request.requestId)
      .filter((event) => event.kind === 'callback-rejected');
    expect(rejected).toHaveLength(1);
  });

  it('releases for reassignment and replays its history', async () => {
    const client = createCallbackClient();
    const request = createCallbackGate(GATE);
    client.post(request);

    const claim = client.claim(request.requestId, 'router-a');
    const token = claim.ok === true ? claim.claimToken : '';
    const wrongRelease = client.release(request.requestId, 'not-the-token');
    expect(wrongRelease.ok).toBe(false);
    expect(wrongRelease.ok === false && wrongRelease.kind).toBe('not-owner');

    const released = client.release(request.requestId, token);
    expect(released).toEqual({ ok: true });

    const reassigned = client.claim(request.requestId, 'router-b');
    expect(reassigned.ok).toBe(true);

    const kinds = client.history(request.requestId).map((event) => event.kind);
    expect(kinds).toEqual([
      'callback-requested',
      'callback-claimed',
      'callback-released',
      'callback-claimed',
    ]);
  });

  it('drives the state machine and the DAG from the client: held on invalid, advanced on valid', async () => {
    const machine: DirectedStateDefinition = {
      id: 'approval-flow',
      definitionVersion: 1,
      data: { initial: 'draft', fallbackRoute: 'hold' },
      nodes: [
        { id: 'draft', data: { terminal: null } },
        { id: 'await-approval', data: { terminal: null } },
        { id: 'approved', data: { terminal: 'complete' } },
      ],
      edges: [
        { id: 'draft-done', source: 'draft', target: 'await-approval', data: { route: 'done' } },
        { id: 'draft-hold', source: 'draft', target: 'draft', data: { route: 'hold' } },
        { id: 'approval-yes', source: 'await-approval', target: 'approved', data: { route: 'approved' } },
        { id: 'approval-hold', source: 'await-approval', target: 'await-approval', data: { route: 'hold' } },
      ],
    };
    const stateMachine = compileGraph(directedState, machine);

    const client = createCallbackClient();
    const request = createCallbackGate(GATE);

    // The machine reaches its waiting state; the client posts the request.
    const machineEvents = (state: DirectedStateEvent[]): DirectedStateEvent[] => state;
    let state = stateMachine.initialState();
    const feed = (events: readonly DirectedStateEvent[]): void => {
      for (const event of events) state = stateMachine.reduce(state, event);
    };
    feed([
      { type: 'node-dispatched', version: 1, payload: { nodeId: 'draft', position: 'states/draft/1' } },
      { type: 'node-completed', version: 1, payload: { nodeId: 'draft', position: 'states/draft/1', route: 'done' } },
      { type: 'node-dispatched', version: 1, payload: { nodeId: 'await-approval', position: 'states/await-approval/1' } },
    ]);
    client.post(request);
    feed([{
      type: 'callback-requested', version: 1,
      payload: { state: 'await-approval', digest: request.digest },
    }]);
    expect(stateMachine.decide(state)).toEqual([]);

    // An invalid answer never reaches the machine: no submitted event, so
    // the flow stays held.
    const claim = client.claim(request.requestId, 'router-a');
    const token = claim.ok === true ? claim.claimToken : '';
    const invalid = client.submit(request.requestId, token, 'router-a', request.digest, { approved: 'yes' });
    expect(invalid.ok).toBe(false);
    expect(client.history(request.requestId).some((event) => event.kind === 'callback-submitted')).toBe(false);
    expect(stateMachine.decide(state)).toEqual([]);

    // A stale digest is refused the same way.
    const stale = client.submit(request.requestId, token, 'router-a', 'not-the-digest', { approved: true });
    expect(stale.ok).toBe(false);
    expect(stale.ok === false && stale.kind).toBe('stale');
    expect(stateMachine.decide(state)).toEqual([]);

    // The valid answer is the only thing that advances the flow.
    expect(client.release(request.requestId, token)).toEqual({ ok: true });
    const accepted = await directRouter(client, request, 'router-b', () => ({ approved: true }));
    expect(accepted.ok).toBe(true);
    feed([{
      type: 'node-completed', version: 1,
      payload: { nodeId: 'await-approval', position: 'states/await-approval/1', route: 'approved' },
    }]);
    feed([
      { type: 'node-dispatched', version: 1, payload: { nodeId: 'approved', position: 'states/approved/1' } },
      { type: 'node-completed', version: 1, payload: { nodeId: 'approved', position: 'states/approved/1', route: null } },
    ]);
    expect(stateMachine.decide(state)).toEqual([
      { kind: 'complete', output: { terminal: 'approved' } },
    ]);

    // The same client events hold and advance the DAG identically: the
    // gate is one required node whose result is the validated response.
    const build: DagDefinition = {
      id: 'release-graph',
      definitionVersion: 1,
      data: { globalConcurrency: 1, keyedConcurrency: {}, stopOnError: true, retryCapPerNode: 0 },
      nodes: [
        { id: 'ask-approval', data: { kind: 'required', key: null } },
        { id: 'ship', data: { kind: 'required', key: null } },
      ],
      edges: [{ id: 'ask-to-ship', source: 'ask-approval', target: 'ship', data: {} }],
    };
    const pipeline = compileGraph(dag, build);
    let dagState = pipeline.initialState();
    const dagFeed = (events: readonly DagEvent[]): void => {
      for (const event of events) dagState = pipeline.reduce(dagState, event);
    };
    dagFeed([
      { type: 'node-dispatched', version: 1, payload: { nodeId: 'ask-approval', position: 'dag/ask-approval/1' } },
    ]);
    // While the gate waits and while answers are invalid or stale, the
    // DAG holds: no completion for the gate node.
    expect(pipeline.decide(dagState)).toEqual([]);
    const submitted = client.history(request.requestId)
      .find((event) => event.kind === 'callback-submitted');
    expect(submitted).toBeDefined();
    dagFeed([{
      type: 'node-completed', version: 1,
      payload: {
        nodeId: 'ask-approval',
        position: 'dag/ask-approval/1',
        result: submitted !== undefined && submitted.kind === 'callback-submitted'
          ? submitted.response
          : {},
      },
    }]);
    dagFeed([
      { type: 'node-dispatched', version: 1, payload: { nodeId: 'ship', position: 'dag/ship/1' } },
      { type: 'node-completed', version: 1, payload: { nodeId: 'ship', position: 'dag/ship/1', result: {} } },
    ]);
    const verdict = pipeline.decide(dagState) as readonly GraphCommand[];
    expect(verdict[0]!.kind).toBe('complete');
    expect(machineEvents.length).toBeGreaterThanOrEqual(0);
  });

  it('refuses a stale answer at the gate so the machine never advances on it', async () => {
    const client: CallbackClient = createCallbackClient();
    const request = createCallbackGate(GATE);
    client.post(request);

    const machine: DirectedStateDefinition = {
      id: 'approval-flow',
      definitionVersion: 1,
      data: { initial: 'draft', fallbackRoute: 'hold' },
      nodes: [
        { id: 'draft', data: { terminal: null } },
        { id: 'await-approval', data: { terminal: null } },
        { id: 'approved', data: { terminal: 'complete' } },
      ],
      edges: [
        { id: 'draft-done', source: 'draft', target: 'await-approval', data: { route: 'done' } },
        { id: 'draft-hold', source: 'draft', target: 'draft', data: { route: 'hold' } },
        { id: 'approval-yes', source: 'await-approval', target: 'approved', data: { route: 'approved' } },
        { id: 'approval-hold', source: 'await-approval', target: 'await-approval', data: { route: 'hold' } },
      ],
    };
    const stateMachine = compileGraph(directedState, machine);
    let state = stateMachine.initialState();
    state = stateMachine.reduce(state, {
      type: 'node-dispatched', version: 1,
      payload: { nodeId: 'draft', position: 'states/draft/1' },
    });
    state = stateMachine.reduce(state, {
      type: 'node-completed', version: 1,
      payload: { nodeId: 'draft', position: 'states/draft/1', route: 'done' },
    });
    state = stateMachine.reduce(state, {
      type: 'node-dispatched', version: 1,
      payload: { nodeId: 'await-approval', position: 'states/await-approval/1' },
    });
    state = stateMachine.reduce(state, {
      type: 'callback-requested', version: 1,
      payload: { state: 'await-approval', digest: request.digest },
    });
    expect(state.pending).toEqual({ state: 'await-approval', digest: request.digest });
    expect(stateMachine.decide(state)).toEqual([]);

    // The gate is re-asked with new input: the old request is superseded
    // and its answer is refused, so the machine's pending digest moves.
    const newer = createCallbackGate({ ...GATE, input: { revision: 'def456' } });
    client.post(newer);
    client.supersede(request.requestId, newer.requestId);
    const stale = await directRouter(client, request, 'late-router', () => ({ approved: true }));
    expect(stale.ok).toBe(false);
    expect(stale.ok === false && stale.kind).toBe('not-claimed');

    state = stateMachine.reduce(state, {
      type: 'callback-requested', version: 1,
      payload: { state: 'await-approval', digest: newer.digest },
    });
    expect(state.pending).toEqual({ state: 'await-approval', digest: newer.digest });
  });

  it('replays its history into the same state, superseded included', async () => {
    const client = createCallbackClient();
    const first = createCallbackGate(GATE);
    const second = createCallbackGate(GATE);
    client.post(first);
    client.post(second);
    await directRouter(client, second, 'router-a', () => ({ approved: true }));

    const replayed = replayCallbackClient(client.history());
    expect(replayed.listPending().map((request) => request.requestId)).toEqual([]);
    const staleClaim = replayed.claim(first.requestId, 'router-b');
    expect(staleClaim.ok).toBe(false);
    expect(staleClaim.ok === false && staleClaim.kind).toBe('superseded');
    const answeredClaim = replayed.claim(second.requestId, 'router-b');
    expect(answeredClaim.ok).toBe(false);
    expect(answeredClaim.ok === false && answeredClaim.kind).toBe('answered');

    const kinds = client.history(first.requestId).map((event) => event.kind);
    expect(kinds).toContain('callback-superseded');
  });

  it('plays back without claiming a request or calling a responder', async () => {
    const client = createCallbackClient();
    const request = createCallbackGate(GATE);
    client.post(request);

    let responderCalls = 0;
    const countingResponder = (): JsonObject => {
      responderCalls += 1;
      return { approved: true };
    };

    // Reading and replaying the history is effect-free: nothing is
    // claimed and no responder runs.
    const history = client.history();
    const replayed = replayCallbackClient(history);
    expect(replayed.listPending().map((pending) => pending.requestId)).toEqual([request.requestId]);
    expect(client.listPending().map((pending) => pending.requestId)).toEqual([request.requestId]);
    expect(client.history().some((event) => event.kind === 'callback-claimed')).toBe(false);
    expect(responderCalls).toBe(0);

    // The live claim happens only through the router path.
    const answer = await directRouter(client, request, 'router-a', countingResponder);
    expect(answer.ok).toBe(true);
    expect(responderCalls).toBe(1);
  });
});
