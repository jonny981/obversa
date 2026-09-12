#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';

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
process.stdout.write(`${JSON.stringify({
  type: 'assistant',
  message: { model, content: [{ type: 'text', text: 'PONG' }] },
})}\n`);
process.stdout.write(`${JSON.stringify({
  type: 'result', result: 'PONG',
  usage: { input_tokens: 3, output_tokens: 1 },
})}\n`);
process.exit(Number(process.env.OBVERSA_TEST_CLAUDE_MODEL_EXIT ?? '0'));
