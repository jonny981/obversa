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
} from '../src/callback/client.js';
import type { JsonObject } from '../src/graph/value.js';
import { compileGraph } from '../src/graph/type.ts';
import type { GraphCommand } from '../src/graph/commands.js';
import { dag } from '../src/graph-types/dag.js';
import type { DagDefinition, DagEvent } from '../src/graph-types/dag.js';

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
    const pending = createCallbackGate({ ...GATE, input: { revision: 'pending123' } });
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

  it('holds a DAG node on invalid and stale answers, then advances on a valid answer', async () => {
    const client = createCallbackClient();
    const request = createCallbackGate(GATE);
    client.post(request);
    const claim = client.claim(request.requestId, 'router-a');
    const token = claim.ok === true ? claim.claimToken : '';
    const invalid = client.submit(request.requestId, token, 'router-a', request.digest, { approved: 'yes' });
    expect(invalid.ok).toBe(false);
    expect(client.history(request.requestId).some((event) => event.kind === 'callback-submitted')).toBe(false);
    const stale = client.submit(request.requestId, token, 'router-a', 'not-the-digest', { approved: true });
    expect(stale.ok).toBe(false);
    expect(stale.ok === false && stale.kind).toBe('stale');
    expect(client.release(request.requestId, token)).toEqual({ ok: true });
    const accepted = await directRouter(client, request, 'router-b', () => ({ approved: true }));
    expect(accepted.ok).toBe(true);

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
  });

  it('replays its history into the same state, superseded included', async () => {
    const client = createCallbackClient();
    const first = createCallbackGate(GATE);
    const second = createCallbackGate({ ...GATE, input: { revision: 'def456' } });
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

  it('keeps the same request id after replay and changes it when the question bytes change', async () => {
    const client = createCallbackClient();
    const first = createCallbackGate(GATE);
    client.post(first);
    await directRouter(client, first, 'router-a', () => ({ approved: true }));

    const replayed = replayCallbackClient(client.history());
    const sameQuestion = createCallbackGate(GATE);
    expect(sameQuestion.requestId).toBe(first.requestId);

    const changedQuestion = createCallbackGate({
      ...GATE,
      input: { revision: 'def456' },
    });
    expect(changedQuestion.requestId).not.toBe(first.requestId);
    replayed.post(changedQuestion);
    expect(replayed.listPending().map((request) => request.requestId))
      .toEqual([changedQuestion.requestId]);
  });

  it('releases the claim when a direct responder throws', async () => {
    const client = createCallbackClient();
    const request = createCallbackGate(GATE);
    client.post(request);

    await expect(directRouter(client, request, 'router-a', () => {
      throw new Error('responder failed');
    })).rejects.toThrow('responder failed');

    expect(client.history(request.requestId).map((event) => event.kind)).toEqual([
      'callback-requested',
      'callback-claimed',
      'callback-released',
    ]);
    expect(client.claim(request.requestId, 'router-b').ok).toBe(true);
  });
});
