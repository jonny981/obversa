#!/usr/bin/env node
// One stand-in CLI installed by host proofs under three names: claude, codex
// and opencode. It reads its role from the name it was invoked as, answers
// --version with the string the real adapter pins, and for a model call
// reads its script from a file named .obversa-stand-in.json in its working
// directory, so no environment variable has to survive the adapter's clean
// child environment: JSON, per role, an ordered list of calls, each
// { "writes": { "path": "content" }, "reply": "text" }. It writes the files
// into its cwd, prints the reply in that role's line protocol, appends one
// line per call to .obversa-stand-in-calls.log beside the script, and exits
// 0. Past the end of the list it repeats the last entry.
import { appendFileSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const role = process.argv[1].split('/').pop();
const VERSIONS = {
  claude: '2.1.261 (Claude Code)\n',
  codex: 'codex-cli 0.153.2\n',
  opencode: '1.18.23\n',
};
const scriptPath = join(process.cwd(), '.obversa-stand-in.json');
const callsLog = join(process.cwd(), '.obversa-stand-in-calls.log');

function call() {
  const all = JSON.parse(readFileSync(scriptPath, 'utf8'));
  const list = all[role];
  if (!Array.isArray(list) || list.length === 0) throw new Error(`stand-in script has no calls for role ${role}`);
  const count = countCalls(role);
  return list[Math.min(count, list.length - 1)];
}

// Two seats of one role can run at the same time (a review panel runs its
// reviewers together), and each would count the same prior calls and take the
// same entry. Counting, choosing and logging happen under one lock, taken by
// creating a directory, which is atomic on every platform Node runs on.
function withCallsLock(fn) {
  const lock = `${callsLog}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { mkdirSync(lock); break; } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() > deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try { return fn(); } finally { rmdirSync(lock); }
}

function countCalls(role) {
  try {
    return readFileSync(callsLog, 'utf8').split('\n').filter(Boolean)
      .filter((line) => JSON.parse(line).role === role).length;
  } catch {
    return 0;
  }
}

if (args.length === 1 && args[0] === '--version') {
  process.stdout.write(VERSIONS[role]);
  process.exit(0);
}

const entry = withCallsLock(() => {
  const chosen = call();
  appendFileSync(callsLog, `${JSON.stringify({
    role,
    reply: chosen.reply,
    writes: chosen.writes ?? {},
    cwd: process.cwd(),
    args,
  })}\n`);
  return chosen;
});
for (const [path, content] of Object.entries(entry.writes ?? {})) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

if (role === 'claude') {
  process.stdout.write(`${JSON.stringify({
    type: 'assistant',
    message: { model: 'stand-in', content: [{ type: 'text', text: entry.reply }] },
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: 'result', result: entry.reply,
    usage: { input_tokens: 3, output_tokens: 1 },
  })}\n`);
} else if (role === 'codex') {
  const outAt = args.indexOf('-o');
  if (outAt !== -1) writeFileSync(args[outAt + 1], entry.reply);
  process.stdout.write(`${JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 42, cached_input_tokens: 30, output_tokens: 7 },
  })}\n`);
} else {
  // OpenCode's stream: a wrapper frame per event with the part inside it,
  // the shape the adapter's parser reads (a text part, then a step-finish
  // part carrying the usage).
  const base = { timestamp: 1_777_777_777_777, sessionID: 'stand-in-session' };
  const part = { sessionID: 'stand-in-session', messageID: 'stand-in-message' };
  process.stdout.write(`${JSON.stringify({
    type: 'text', ...base,
    part: { ...part, id: 'stand-in-text', type: 'text', text: entry.reply, time: { start: 1, end: 2 } },
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: 'step_finish', ...base,
    part: {
      ...part, id: 'stand-in-finish', type: 'step-finish', reason: 'stop', cost: 0,
      tokens: { input: 2, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
    },
  })}\n`);
}
process.exit(0);
