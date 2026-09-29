import { codex } from '@obversa/engine-codex-cli';
import { run } from '@obversa/runtime';
import { humanFeedbackWorkflow } from './human-feedback/workflow.js';

// Run with a signed-in Codex CLI and OBVERSA_MODEL set to your model name.
const model = process.env.OBVERSA_MODEL;
if (!model) throw new Error('Set OBVERSA_MODEL to the Codex model you want to use.');
const writer = codex(model, { sandbox: 'read-only' });
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const result = await run(humanFeedbackWorkflow(writer.engine, model), {
    signal: controller.signal,
    recordTo: 'records/human-feedback.jsonl',
    resume: process.argv.includes('--resume'),
  });
  console.log(JSON.stringify({ status: result.outcome.status, proposal: result.outcome.data }, null, 2));
  if (result.outcome.status !== 'pass') process.exitCode = 1;
} finally {
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
}
