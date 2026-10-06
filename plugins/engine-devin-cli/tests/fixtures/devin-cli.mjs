#!/usr/bin/env node
// A hand-written stand-in for the `devin` CLI. Its export follows the shape
// Devin 3000.11 writes; it is not a capture of a real conversation.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const version = args.length === 1 && args[0] === '--version';
const promptFile = valueAfter('--prompt-file');
const configFile = valueAfter('--config');
const calls = process.env.OBVERSA_TEST_DEVIN_CALLS;
if (calls) appendFileSync(calls, `${JSON.stringify({
  kind: version ? 'version' : 'model',
  executable: process.argv[1],
  args,
  stdin: readFileSync(0, 'utf8'),
  cwd: process.cwd(),
  pid: process.pid,
  prompt: promptFile === undefined ? null : readFileSync(promptFile, 'utf8'),
  config: configFile === undefined ? null : readFileSync(configFile, 'utf8'),
  env: {
    HOME: process.env.HOME ?? null,
    OBVERSA_TEST_PERSON: process.env.OBVERSA_TEST_PERSON ?? null,
    OBVERSA_TEST_REQUEST: process.env.OBVERSA_TEST_REQUEST ?? null,
    OBVERSA_LEAF_ID: process.env.OBVERSA_LEAF_ID ?? null,
  },
})}\n`);

if (version) {
  process.stdout.write(process.env.OBVERSA_TEST_DEVIN_VERSION_STDOUT ?? 'devin 3000.11.3 (9c803229faa4)\n');
  process.exit(0);
}

const exportFile = valueAfter('--export');
if (!args.includes('-p') || promptFile === undefined || exportFile === undefined
  || valueAfter('--permission-mode') === undefined) {
  throw new Error('fixture requires -p, --prompt-file, --export and --permission-mode');
}
const scenario = process.env.OBVERSA_ENGINE_CONFORMANCE_SCENARIO
  || process.env.OBVERSA_TEST_DEVIN_SCENARIO || 'ordered-parts';
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
if (scenario === 'missing-export') process.exit(0);
const delay = Number(process.env.OBVERSA_TEST_DEVIN_DELAY_MS ?? 0);
if (delay > 0) await new Promise((resolve) => { setTimeout(resolve, delay); });

const model = scenario === 'other-model' ? 'swe-1-7-lightning' : valueAfter('--model') ?? 'swe-2-max';
const agent = (step_id, message, extra = {}) => ({ step_id, source: 'agent', model_name: model, message, ...extra });
// Like Devin, `-r <id>` continues a saved session: its export holds every
// earlier step, and its totals cover every run in the session.
const resumed = valueAfter('-r');
const sessionId = resumed ?? `session-${process.pid}`;
const sessionFile = calls ? `${calls}.${sessionId}.json` : undefined;
if (resumed !== undefined && (sessionFile === undefined || !existsSync(sessionFile))) {
  process.stderr.write(`no session ${resumed}`);
  process.exit(1);
}
const session = resumed === undefined
  ? { steps: [{ step_id: 1, source: 'system', message: 'You are Devin.' }], prompt: 0, completion: 0 }
  : JSON.parse(readFileSync(sessionFile, 'utf8'));
const steps = session.steps;
steps.push({ step_id: steps.length + 1, source: 'user', message: readFileSync(promptFile, 'utf8') });
const refusedCall = (step_id, id, function_name, args, message = '') => agent(step_id, message, {
  tool_calls: [{ tool_call_id: id, function_name, arguments: args }],
  observation: { results: [{ source_call_id: id, content: 'Tool execution was rejected by the user' }] },
});
let refused = false;
if (scenario === 'refused-tool') {
  steps.push(refusedCall(steps.length + 1, `write:${steps.length}`, 'write', { file_path: 'created.txt' }));
  refused = true;
} else if (scenario === 'refused-command-once') {
  // The first run is refused `rg`; the continued run reads the file and answers.
  if (resumed === undefined) {
    steps.push(refusedCall(steps.length + 1, 'exec:0', 'exec', { command: 'rg word- note.txt' }, 'Searching.'));
    refused = true;
  } else {
    steps.push(agent(steps.length + 1, '', {
      tool_calls: [{ tool_call_id: 'read:0', function_name: 'read', arguments: { file_path: 'note.txt' } }],
      observation: { results: [{ source_call_id: 'read:0', content: 'word-1' }] },
    }));
    steps.push(agent(steps.length + 1, 'answer'));
  }
  session.prompt += resumed === undefined ? 5 : 7;
  session.completion += resumed === undefined ? 3 : 2;
} else if (scenario === 'tool-events') {
  steps.push(agent(3, '', {
    tool_calls: [{ tool_call_id: 'read:0', function_name: 'read', arguments: { file_path: 'a.js' } }],
    observation: { results: [{ source_call_id: 'read:0', content: 'export const a = 1;' }] },
  }));
  steps.push(agent(4, 'answer'));
} else if (scenario === 'no-answer') {
  steps.push(agent(3, '', {
    tool_calls: [{ tool_call_id: 'read:0', function_name: 'read', arguments: { file_path: 'a.js' } }],
    observation: { results: [{ source_call_id: 'read:0', content: 'export const a = 1;' }] },
  }));
} else {
  steps.push(agent(3, 'draft'));
  steps.push(agent(4, scenario === 'structured-result'
    ? '{"answer":42}'
    : [{ type: 'text', text: 'ans' }, { type: 'text', text: 'wer' }]));
}
const exportValue = {
  schema_version: 'ATIF-v1.7',
  session_id: sessionId,
  agent: { name: 'devin', version: '3000.11.3', model_name: 'Display label' },
  steps,
  ...(scenario === 'reported-usage'
    ? { final_metrics: { total_prompt_tokens: 5, total_completion_tokens: 3 } }
    : scenario === 'cached-usage'
      ? { final_metrics: { total_prompt_tokens: 22833, total_completion_tokens: 208, total_cached_tokens: 9216 } }
      : scenario === 'refused-command-once'
        ? { final_metrics: { total_prompt_tokens: session.prompt, total_completion_tokens: session.completion } }
        : {}),
};
// Only a refused run is continued, so only it saves its session.
if (refused && sessionFile !== undefined) writeFileSync(sessionFile, JSON.stringify(session));
writeFileSync(exportFile, scenario === 'malformed-export' ? '{"schema_version":' : JSON.stringify(exportValue));
if (refused) {
  process.stderr.write('warning: rejected a tool call that requires confirmation. Running in non-interactive mode.\n');
}
process.exit(scenario === 'late-final' ? 7 : 0);
