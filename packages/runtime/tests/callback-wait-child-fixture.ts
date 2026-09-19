import { approval, createCallbackClient, run } from '../src/api.ts';

const client = createCallbackClient();
let pendingReads = 0;
process.on('message', async () => {
  const [request] = client.listPending();
  const claim = client.claim(request!.requestId, 'parent');
  if (!claim.ok) throw new Error(`claim refused: ${claim.kind}`);
  const submitted = client.submit(request!.requestId, claim.claimToken, 'parent', request!.digest, { approved: true });
  if (!submitted.ok) throw new Error(`answer refused: ${submitted.kind}`);
});
// Only the runtime's wait may keep this child alive, not the test's IPC channel.
process.channel?.unref();

const result = await run(approval('approve', { question: 'Send?' }), {
  onCallback: 'wait',
  callbacks: {
    ...client,
    async history(requestId) {
      const events = client.history(requestId);
      if (events.some((event) => event.kind === 'callback-requested')
          && !events.some((event) => event.kind === 'callback-submitted')) {
        pendingReads += 1;
        // One read observes the post, the next requires a live polling timer.
        if (pendingReads === 2) process.send?.({ waiting: true });
      }
      return events;
    },
  },
});
console.log(result.outcome.status);
process.exitCode = result.outcome.status === 'pass' ? 0 : 1;
process.disconnect();
