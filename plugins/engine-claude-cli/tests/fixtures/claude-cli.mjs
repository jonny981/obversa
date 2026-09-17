#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const bootDelayMs = Number(process.env.OBVERSA_TEST_CLAUDE_BOOT_DELAY_MS ?? 0);
if (bootDelayMs > 0) await delay(bootDelayMs);

const args = process.argv.slice(2);
const calls = process.env.OBVERSA_TEST_CLAUDE_CALLS;
const version = args.length === 1 && args[0] === '--version';
const stdin = readFileSync(0, 'utf8');
if (calls) appendFileSync(calls, `${JSON.stringify({
  kind: version ? 'version' : 'model',
  executable: process.argv[1], args, stdin, cwd: process.cwd(),
})}\n`);

if (version) {
  const mode = process.env.OBVERSA_TEST_CLAUDE_VERSION_MODE;
  if (mode === 'hang') {
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
  }
  if (mode === 'fail-once' && calls
    && readFileSync(calls, 'utf8').trim().split('\n')
      .filter((line) => JSON.parse(line).kind === 'version').length === 1) {
    process.exit(2);
  }
  if (mode === 'exit') process.exit(2);
  if (mode === 'overflow') {
    process.stdout.write('x'.repeat(8_192));
    process.exit(0);
  }
  if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 150));
  process.stdout.write(process.env.OBVERSA_TEST_CLAUDE_VERSION_STDOUT
    ?? '2.1.261 (Claude Code)\n');
  process.exit(0);
}

const modelAt = args.indexOf('--model');
const requestedModel = modelAt === -1 ? 'claude-test' : args[modelAt + 1];
const model = process.env.OBVERSA_TEST_CLAUDE_EFFECTIVE_MODEL ?? requestedModel;
const scenario = process.env.OBVERSA_ENGINE_CONFORMANCE_SCENARIO;
if (scenario) {
  const errors = {
    auth: '401 unauthorized', billing: '402 payment required',
    'model-unavailable': 'unknown model fixture', 'rate-limit': '429 rate limit reached',
    quota: 'monthly usage limit reached', transient: '503 service unavailable',
    'invalid-config': 'invalid configuration',
  };
  if (errors[scenario]) {
    const stream = process.env.OBVERSA_TEST_CLAUDE_FAILURE_STREAM === 'stdout'
      ? process.stdout : process.stderr;
    stream.write(errors[scenario]);
    process.exit(1);
  }
  const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const assistant = (text) => emit({ type: 'assistant', message: { model, content: [{ type: 'text', text }] } });
  if (scenario === 'timeout' || scenario === 'cancellation') {
    if (scenario === 'cancellation') assistant('started');
    await new Promise(() => { setInterval(() => {}, 1_000); });
  }
  if (scenario === 'ordered-parts') assistant('draft');
  const answer = scenario === 'structured-result' ? '{"answer":42}' : 'answer';
  assistant(answer);
  emit({ type: 'result', result: answer,
    ...(scenario === 'reported-usage' ? { usage: { input_tokens: 5, output_tokens: 3 } } : {}),
  });
  process.exit(scenario === 'late-final' ? 7 : 0);
}
process.stdout.write(`${JSON.stringify({
  type: 'assistant',
  message: { model, content: [{ type: 'text', text: 'PONG' }] },
})}\n`);
process.stdout.write(`${JSON.stringify({
  type: 'result', result: 'PONG',
  usage: { input_tokens: 3, output_tokens: 1 },
})}\n`);
process.exit(Number(process.env.OBVERSA_TEST_CLAUDE_MODEL_EXIT ?? '0'));
