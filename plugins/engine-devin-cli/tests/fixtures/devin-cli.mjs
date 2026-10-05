#!/usr/bin/env node
// A hand-written stand-in for the `devin` CLI. Its export follows the shape
// Devin 3000.11 writes; it is not a capture of a real conversation.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

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

const model = scenario === 'other-model' ? 'swe-1-7-lightning' : valueAfter('--model') ?? 'swe-2-max';
const agent = (step_id, message, extra = {}) => ({ step_id, source: 'agent', model_name: model, message, ...extra });
const steps = [
  { step_id: 1, source: 'system', message: 'You are Devin.' },
  { step_id: 2, source: 'user', message: readFileSync(promptFile, 'utf8') },
];
if (scenario === 'tool-events') {
  steps.push(agent(3, '', {
    tool_calls: [{ tool_call_id: 'read:0', function_name: 'read', arguments: { file_path: 'a.js' } }],
    observation: { results: [{ source_call_id: 'read:0', content: 'export const a = 1;' }] },
  }));
  steps.push(agent(4, 'answer'));
} else if (scenario === 'refused-tool') {
  steps.push(agent(3, '', {
    tool_calls: [{ tool_call_id: 'write:0', function_name: 'write', arguments: { file_path: 'created.txt' } }],
    observation: { results: [{ source_call_id: 'write:0', content: 'Tool execution was rejected by the user' }] },
  }));
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
  session_id: 'fixture',
  agent: { name: 'devin', version: '3000.11.3', model_name: 'Display label' },
  steps,
  ...(scenario === 'reported-usage'
    ? { final_metrics: { total_prompt_tokens: 5, total_completion_tokens: 3 } }
    : scenario === 'cached-usage'
      ? { final_metrics: { total_prompt_tokens: 22833, total_completion_tokens: 208, total_cached_tokens: 9216 } }
      : {}),
};
writeFileSync(exportFile, scenario === 'malformed-export' ? '{"schema_version":' : JSON.stringify(exportValue));
if (scenario === 'refused-tool') {
  process.stderr.write('warning: rejected a tool call that requires confirmation. Running in non-interactive mode.\n');
}
process.exit(scenario === 'late-final' ? 7 : 0);
