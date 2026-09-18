#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const bootDelayMs = Number(process.env.OBVERSA_TEST_CODEX_BOOT_DELAY_MS ?? 0);
if (bootDelayMs > 0) await delay(bootDelayMs);

const args = process.argv.slice(2);
const calls = process.env.OBVERSA_TEST_CODEX_CALLS;
const version = args.length === 1 && args[0] === '--version';
const stdin = readFileSync(0, 'utf8');
if (calls) appendFileSync(calls, `${JSON.stringify({
  kind: version ? 'version' : 'model', executable: process.argv[1],
  args, stdin, cwd: process.cwd(),
})}\n`);
if (version) {
  const mode = process.env.OBVERSA_TEST_CODEX_VERSION_MODE;
  if (mode === 'hang') {
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
  }
  if (mode === 'fail-once' && calls
    && readFileSync(calls, 'utf8').trim().split('\n')
      .filter((line) => JSON.parse(line).kind === 'version').length === 1) process.exit(2);
  if (mode === 'exit') process.exit(2);
  if (mode === 'overflow') {
    process.stdout.write('x'.repeat(8_192));
    process.exit(0);
  }
  if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 150));
  process.stdout.write(process.env.OBVERSA_TEST_CODEX_VERSION_STDOUT ?? 'codex-cli 0.153.2\n');
  process.exit(0);
}

const outAt = args.indexOf('-o');
if (outAt === -1) throw new Error('fixture requires normal output file');
const scenario = process.env.OBVERSA_ENGINE_CONFORMANCE_SCENARIO;
if (scenario) {
  const errors = {
    auth: '401 unauthorized', billing: '402 payment required',
    'model-unavailable': 'unknown model fixture', 'rate-limit': '429 rate limit reached',
    quota: 'monthly usage limit reached', transient: '503 service unavailable',
    'invalid-config': 'invalid configuration',
  };
  if (errors[scenario]) {
    process.stderr.write(errors[scenario]);
    process.exit(1);
  }
  if (scenario === 'timeout') await new Promise(() => { setInterval(() => {}, 1_000); });
  writeFileSync(args[outAt + 1], scenario === 'structured-result' ? '{"answer":42}' : 'answer');
  if (scenario === 'reported-usage') process.stdout.write(`${JSON.stringify({
    type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 3 },
  })}\n`);
  process.exit(scenario === 'late-final' ? 7 : 0);
}
writeFileSync(args[outAt + 1], 'PONG');
process.stdout.write(`${JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 42, cached_input_tokens: 30, output_tokens: 7 },
})}\n`);
process.exit(Number(process.env.OBVERSA_TEST_CODEX_MODEL_EXIT ?? '0'));
