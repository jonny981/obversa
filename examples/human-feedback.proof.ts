import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run, type AgentRequest, type InteractionResponse } from '@obversa/runtime';
import { MockEngine } from '@obversa/runtime/testing';
import { openProposalReview } from './human-feedback/surface.js';
import { humanFeedbackWorkflow } from './human-feedback/workflow.js';

// Only the model replies are scripted. The workflow, callback and HTTP surface are real.
const cwd = await mkdtemp(join(tmpdir(), 'obversa-human-feedback-proof-'));
const requests: AgentRequest[] = [];
const responses: InteractionResponse[] = [];
let reviews = 0;
try {
  const engine = new MockEngine((request) => {
    requests.push(request);
    return JSON.stringify({
      title: requests.length === 1 ? 'A better introduction' : 'Start with your first review',
      sections: [
        { id: 'opening', text: `Draft ${requests.length}: describe the first review.` },
        { id: 'details', text: 'Keep the steps that already work.' },
      ],
    });
  });
  const job = humanFeedbackWorkflow(engine, 'original-writer', async (request, signal) => {
    reviews += 1;
    const round = reviews;
    const controller = new AbortController();
    let browser!: Promise<void>;
    const result = await openProposalReview(request, AbortSignal.any([signal, controller.signal]), {
      open: false,
      ready(info) {
        browser = (async () => {
          const headers = { Authorization: `Bearer ${new URL(info.url).hash.slice(1)}`, Origin: info.origin, 'Content-Type': 'application/json' };
          async function call(path: string, body?: unknown) {
            const reply = await fetch(`${info.origin}${path}`, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
            assert.equal(reply.status, 200, `${path}: ${await reply.clone().text()}`);
            return await reply.json() as Record<string, unknown>;
          }
          const { proposal } = await call('/api/proposal');
          assert.deepEqual(proposal, (request.input as { material: unknown }).material);
          const answer = {
            audience: 'first-time visitors', title: 'Start with your first review',
            annotations: [{ sectionId: 'opening', note: `Make revision ${round} more concrete.` }],
          };
          if (round < 3) {
            const preview = await call('/api/preview', answer);
            assert.ok(String(preview.prompt).includes(`Draft ${round}: describe the first review.`));
            assert.ok(String(preview.prompt).includes(answer.annotations[0]!.note));
          }
          const reply = await call(round < 3 ? '/api/feedback' : '/api/approve', round < 3 ? answer : {});
          await call('/api/ack', { operationId: reply.operationId });
        })();
        void browser.catch(() => controller.abort());
      },
    });
    await browser;
    assert.ok(result);
    responses.push(result);
    return result;
  });
  const result = await run(job, { cwd, recordTo: join(cwd, 'record.jsonl') });
  assert.equal(result.outcome.status, 'pass', result.outcome.summary);
  assert.equal(reviews, 3);
  assert.equal(requests.length, 3);
  assert.deepEqual(responses.map((response) => response.decision), ['changes-requested', 'changes-requested', 'approved']);
  for (let index = 1; index < requests.length; index += 1) {
    assert.equal(requests[index]!.model, 'original-writer');
    assert.ok(requests[index]!.prompt.includes(JSON.stringify(responses[index - 1])));
    assert.ok(requests[index]!.prompt.includes(`Draft ${index}: describe the first review.`));
    assert.ok(requests[index]!.prompt.includes('Keep the steps that already work.'));
  }
  assert.equal((responses[2]!.feedback as { proposal: { sections: { text: string }[] } }).proposal.sections[0]!.text, 'Draft 3: describe the first review.');
  console.log(JSON.stringify({ status: result.outcome.status, drafts: requests.length, feedbackRounds: 2, explicitApproval: true }));
} finally {
  await rm(cwd, { recursive: true, force: true });
}
