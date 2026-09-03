import {
  createCallbackClient,
  createCallbackGate,
  directRouter,
  replayCallbackClient,
  type CallbackGateDefinition,
} from '@obversa/runtime';

const definition: CallbackGateDefinition = {
  gateId: 'release-approval',
  gateVersion: 1,
  decisionText: 'Approve release abc123?',
  responseSchema: {
    type: 'object',
    properties: { approved: { type: 'boolean' } },
    required: ['approved'],
  },
  input: { revision: 'abc123' },
};

const client = createCallbackClient();
const request = createCallbackGate(definition);
client.post(request);

const firstClaim = client.claim(request.requestId, 'router-a');
const blockedClaim = client.claim(request.requestId, 'router-b');
if (!firstClaim.ok) throw new Error('The first router did not claim the request.');
const released = client.release(request.requestId, firstClaim.claimToken);
const submitted = await directRouter(
  client,
  request,
  'router-b',
  () => ({ approved: true }),
);

const sameQuestion = createCallbackGate({
  ...definition,
  presentation: { theme: 'dark' },
});
const changedQuestion = createCallbackGate({
  ...definition,
  input: { revision: 'def456' },
});
const replayed = replayCallbackClient(client.history());

console.log(JSON.stringify({
  requestId: request.requestId,
  digest: request.digest,
  sameQuestionId: sameQuestion.requestId === request.requestId,
  changedQuestionId: changedQuestion.requestId !== request.requestId,
  blockedKind: blockedClaim.ok ? null : blockedClaim.kind,
  released: released.ok,
  submitted: submitted.ok,
  events: client.history(request.requestId).map((event) => event.kind),
  replayedPending: replayed.listPending().length,
}));
