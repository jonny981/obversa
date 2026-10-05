#!/usr/bin/env node

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const bootDelayMs = Number(process.env.OBVERSA_TEST_GROK_BOOT_DELAY_MS ?? 0);
if (bootDelayMs > 0) await delay(bootDelayMs);

const args = process.argv.slice(2);

function recordInvocation(kind) {
  if (!process.env.OBVERSA_TEST_GROK_CALLS) return;
  const grokHome = process.env.GROK_HOME;
  appendFileSync(process.env.OBVERSA_TEST_GROK_CALLS, `${JSON.stringify({
    kind,
    program: fileURLToPath(import.meta.url),
    args,
    ...(kind === 'version' ? { stdin: readFileSync(0, 'utf8') } : {}),
    cwd: process.cwd(),
    promptFilePresent: grokHome
      ? existsSync(join(dirname(grokHome), 'prompt.md'))
      : false,
    home: process.env.HOME ?? null,
    grokHome: grokHome ?? null,
    parentValue: process.env.OBVERSA_TEST_GROK_PARENT_VALUE ?? null,
  })}\n`);
}

if (args.length === 1 && args[0] === '--version') {
  recordInvocation('version');
  const mode = process.env.OBVERSA_TEST_GROK_VERSION_MODE;
  if (mode === 'hang') {
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
  }
  if (mode === 'exit') {
    process.stderr.write('scripted unsupported version command\n');
    process.exit(2);
  }
  if (mode === 'fail-once' && process.env.OBVERSA_TEST_GROK_CALLS
    && readFileSync(process.env.OBVERSA_TEST_GROK_CALLS, 'utf8').trim().split('\n')
      .filter((line) => JSON.parse(line).kind === 'version').length === 1) {
    process.exit(2);
  }
  if (mode === 'overflow') {
    process.stdout.write('x'.repeat(8_192));
    process.exit(0);
  }
  process.stdout.write(process.env.OBVERSA_TEST_GROK_VERSION_STDOUT
    ?? 'grok 1.0.44 (5b807183dd79) [stable]\n');
  if (mode === 'cleanup-success' || mode === 'cleanup-error') {
    const locked = join(process.env.GROK_HOME, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'marker'), 'cleanup marker');
    chmodSync(locked, 0);
  }
  if (mode === 'cleanup-error') process.exit(2);
  process.exit(0);
}

recordInvocation('model');

function value(flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function markFinalWritten() {
  if (process.env.OBVERSA_TEST_GROK_FINAL_MARKER) {
    writeFileSync(process.env.OBVERSA_TEST_GROK_FINAL_MARKER, 'written');
  }
}

const promptFile = value('--prompt-file');
const prompt = promptFile ? readFileSync(promptFile, 'utf8') : '';
const scenario = process.env.OBVERSA_ENGINE_CONFORMANCE_SCENARIO
  ?? process.env.OBVERSA_TEST_GROK_SCENARIO
  ?? 'ordered-parts';
if (scenario === 'timeout-final' || scenario === 'timeout-final-structured') process.on('SIGTERM', () => {});
const requestedModel = value('--model') ?? null;
const effectiveModel = process.env.OBVERSA_TEST_GROK_EFFECTIVE_MODEL
  ?? 'grok-4-fixture-effective';
const structured = scenario === 'structured'
  || scenario === 'structured-result'
  || scenario === 'structured-subagent'
  || scenario === 'structured-error-auth-echo'
  || scenario === 'timeout-final-structured';
const finalText = scenario === 'late-final'
  ? 'Quota advice belongs in the answer.'
  : 'answer';

if (process.env.OBVERSA_TEST_GROK_RECORD) {
  writeFileSync(process.env.OBVERSA_TEST_GROK_RECORD, JSON.stringify({
    args,
    cwd: process.cwd(),
    promptFile,
    prompt,
    attempt: {
      attemptId: process.env.OBVERSA_ATTEMPT_ID ?? null,
      runId: process.env.OBVERSA_RUN_ID ?? null,
      headless: process.env.OBVERSA_HEADLESS ?? null,
    },
    environment: {
      home: process.env.HOME ?? null,
      grokHome: process.env.GROK_HOME ?? null,
      grokVariables: Object.fromEntries(Object.entries(process.env)
        .filter(([name]) => name.startsWith('GROK_'))),
      auth: process.env.GROK_HOME
        && existsSync(`${process.env.GROK_HOME}/auth.json`)
        ? readFileSync(`${process.env.GROK_HOME}/auth.json`, 'utf8')
        : null,
      selected: process.env.OBVERSA_TEST_GROK_SELECTED ?? null,
      requestSecret: process.env.OBVERSA_TEST_GROK_REQUEST_SECRET ?? null,
      parentValue: process.env.OBVERSA_TEST_GROK_PARENT_VALUE ?? null,
      subagents: process.env.GROK_SUBAGENTS ?? null,
    },
  }));
}

if (scenario === 'not-signed-in') {
  // Grok 1.0.44 prints an empty start frame before it reports the failure.
  emit({
    type: 'system', subtype: 'init', session_id: '', model: 'unknown', cwd: '',
    permissionMode: 'default', tools: [], uuid: 'fixture-placeholder-init',
  });
  emit({
    type: 'result', subtype: 'error_during_execution', is_error: true,
    errors: ['Not signed in. Run grok login.'], session_id: '',
    uuid: 'fixture-not-signed-in',
  });
  process.exit(1);
}
if (scenario === 'auth') {
  process.stderr.write('401 unauthorized: run grok login\n');
  process.exit(1);
}
if (scenario === 'auth-echo') {
  const auth = JSON.parse(readFileSync(`${process.env.GROK_HOME}/auth.json`, 'utf8'));
  process.stderr.write(`authentication failed for ${auth.token}\n`);
  process.exit(1);
}
if (scenario === 'billing') {
  process.stderr.write('402 payment required: exhausted credit balance\n');
  process.exit(1);
}
if (scenario === 'model-unavailable') {
  process.stderr.write(`unknown model ${requestedModel ?? 'missing'}\n`);
  process.exit(1);
}
if (scenario === 'rate-limit') {
  process.stderr.write('429 rate limit reached\n');
  process.exit(1);
}
if (scenario === 'quota') {
  process.stderr.write('monthly usage limit reached\n');
  process.exit(1);
}
if (scenario === 'ambiguous-limit') {
  process.stderr.write('quota allowance reached\n');
  process.exit(1);
}
if (scenario === 'transient') {
  process.stderr.write('503 service unavailable\n');
  process.exit(1);
}
if (scenario === 'timeout') {
  process.stderr.write('timed out waiting for provider\n');
  process.exit(1);
}
if (scenario === 'invalid-config') {
  process.stderr.write('invalid configuration for grok fixture\n');
  process.exit(1);
}

if (structured) {
  if (scenario === 'structured-error-auth-echo') {
    const auth = JSON.parse(readFileSync(`${process.env.GROK_HOME}/auth.json`, 'utf8'));
    process.stdout.write(`${JSON.stringify({
      type: 'error',
      message: `authentication failed for ${auth.token}`,
    }, null, 2)}\n`);
    process.exit(1);
  }
  const modelUsage = {
    [effectiveModel]: {
      inputTokens: 2,
      outputTokens: 5,
      cacheReadInputTokens: 3,
      modelCalls: 1,
    },
    ...(scenario === 'structured-subagent'
      ? {
          'grok-child-model': {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            modelCalls: 1,
          },
        }
      : {}),
  };
  process.stdout.write(`${JSON.stringify({
    text: '{"answer":42}',
    stopReason: 'end_turn',
    sessionId: 'fixture-session',
    requestId: 'fixture-request',
    usage: {
      input_tokens: 2,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 0,
    },
    modelUsage,
    structuredOutput: { answer: 42 },
  }, null, 2)}\n`);
  markFinalWritten();
  if (scenario === 'timeout-final' || scenario === 'timeout-final-structured') {
    await new Promise((resolve) => setTimeout(resolve, 500));
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
  } else process.exit(0);
}

emit({
  type: 'system',
  subtype: 'init',
  session_id: scenario === 'extra-capability-empty-session' ? '' : 'fixture-session',
  model: effectiveModel,
  cwd: value('--cwd') ?? process.cwd(),
  permissionMode: value('--permission-mode') ?? 'default',
  // Grok 1.0.44 takes `run_terminal_cmd` and reports `run_terminal_command`,
  // and reports `task` as its three subagent tools.
  tools: [
    ...(value('--tools') ?? '').split(',').filter(Boolean)
      .filter((tool) => !(value('--disallowed-tools') ?? '').split(',').includes(tool))
      .flatMap((tool) =>
      tool === 'run_terminal_cmd'
        ? ['run_terminal_command']
        : tool === 'task'
          ? ['kill_command_or_subagent', 'get_command_or_subagent_output', 'spawn_subagent']
          : [tool]),
    ...(scenario === 'extra-capability' || scenario === 'extra-capability-empty-session'
      ? ['write_file']
      : []),
    // Grok 1.0.44 lists the tools of a person's own MCP server that connected
    // before the start frame, even when `--deny MCPTool` keeps them from the model.
    ...(scenario === 'mcp-tool-listed' ? ['analytics__exec'] : []),
    ...(scenario === 'unlisted-server-tool' ? ['other__exec'] : []),
  ],
  ...(scenario === 'mcp-tool-listed' || scenario === 'unlisted-server-tool'
    ? { mcp_servers: [{ name: 'analytics', status: 'pending' }] }
    : {}),
  uuid: 'fixture-init',
});

if (scenario === 'model-unavailable-after-init') {
  process.stderr.write(`unknown model ${effectiveModel}\n`);
  process.exit(1);
}

if (scenario === 'cancellation') {
  emit({
    type: 'assistant',
    message: {
      id: 'fixture-ready',
      type: 'message',
      role: 'assistant',
      model: effectiveModel,
      content: [{ type: 'thinking', thinking: 'fixture-ready' }],
      stop_reason: null,
      usage: {},
    },
    parent_tool_use_id: null,
    session_id: 'fixture-session',
    uuid: 'fixture-ready-line',
  });
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
} else if (scenario === 'tool-events') {
  emit({
    type: 'assistant',
    message: {
      id: 'fixture-tool',
      type: 'message',
      role: 'assistant',
      model: effectiveModel,
      content: [
        { type: 'text', text: 'checking' },
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'read_file',
          input: { path: 'README.md' },
        },
      ],
      stop_reason: 'tool_use',
      usage: {},
    },
    parent_tool_use_id: null,
    session_id: 'fixture-session',
    uuid: 'fixture-tool-line',
  });
  emit({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: 'contents',
        is_error: false,
      }],
    },
    parent_tool_use_id: null,
    session_id: 'fixture-session',
    uuid: 'fixture-tool-result-line',
  });
  emit({
    type: 'assistant',
    message: {
      id: 'fixture-final',
      type: 'message',
      role: 'assistant',
      model: effectiveModel,
      content: [{ type: 'text', text: 'answer' }],
      stop_reason: 'end_turn',
      usage: {},
    },
    parent_tool_use_id: null,
    session_id: 'fixture-session',
    uuid: 'fixture-final-line',
  });
} else if (scenario === 'extra-capability') {
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (process.env.OBVERSA_TEST_GROK_EFFECT) {
    writeFileSync(process.env.OBVERSA_TEST_GROK_EFFECT, 'ran');
  }
} else {
  if (scenario !== 'late-final') {
    emit({
      type: 'assistant',
      message: {
        id: 'fixture-draft',
        type: 'message',
        role: 'assistant',
        model: effectiveModel,
        content: [
          { type: 'thinking', thinking: 'considering' },
          { type: 'text', text: 'draft' },
        ],
        stop_reason: 'pause_turn',
        usage: {},
      },
      parent_tool_use_id: null,
      session_id: 'fixture-session',
      uuid: 'fixture-draft-line',
    });
  }
  emit({
    type: 'assistant',
    message: {
      id: 'fixture-final',
      type: 'message',
      role: 'assistant',
      model: effectiveModel,
      content: [{ type: 'text', text: finalText }],
      stop_reason: 'end_turn',
      usage: {},
    },
    parent_tool_use_id: null,
    session_id: 'fixture-session',
    uuid: 'fixture-final-line',
  });
}

const usage = scenario === 'unknown-usage'
  ? undefined
  : scenario === 'reported-usage'
    ? {
        input_tokens: 5,
        output_tokens: 3,
      }
    : {
        input_tokens: 2,
        output_tokens: 5,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 0,
      };
const result = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: structured ? '' : finalText,
  stop_reason: 'end_turn',
  session_id: 'fixture-session',
  uuid: 'fixture-result-line',
  ...(usage ? { usage } : {}),
};
emit(result);
markFinalWritten();

if (scenario === 'late-final') {
  process.stderr.write('transport closed after final result\n');
  process.exit(7);
}
if (scenario === 'timeout-final' || scenario === 'timeout-final-structured') {
  await new Promise((resolve) => setTimeout(resolve, 500));
  setInterval(() => {}, 1_000);
}
