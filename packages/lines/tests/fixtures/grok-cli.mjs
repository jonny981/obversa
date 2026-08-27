#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);

function value(flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const promptFile = value('--prompt-file');
const prompt = promptFile ? readFileSync(promptFile, 'utf8') : '';
const scenario = process.env.LINES_ENGINE_CONFORMANCE_SCENARIO
  ?? process.env.LINES_TEST_GROK_SCENARIO
  ?? 'ordered-parts';
const requestedModel = value('--model') ?? null;
const effectiveModel = process.env.LINES_TEST_GROK_EFFECTIVE_MODEL
  ?? 'grok-4-fixture-effective';
const structured = scenario === 'structured'
  || scenario === 'structured-result'
  || scenario === 'structured-subagent'
  || scenario === 'structured-error-auth-echo';
const finalText = scenario === 'late-final'
  ? 'Quota advice belongs in the answer.'
  : 'answer';

if (process.env.LINES_TEST_GROK_RECORD) {
  writeFileSync(process.env.LINES_TEST_GROK_RECORD, JSON.stringify({
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
      home: process.env.HOME ?? '',
      grokHome: process.env.GROK_HOME ?? '',
      config: process.env.GROK_HOME
        ? readFileSync(`${process.env.GROK_HOME}/config.toml`, 'utf8')
        : '',
      auth: process.env.GROK_HOME
        && existsSync(`${process.env.GROK_HOME}/auth.json`)
        ? readFileSync(`${process.env.GROK_HOME}/auth.json`, 'utf8')
        : null,
      selected: process.env.LINES_TEST_GROK_SELECTED ?? null,
      requestSecret: process.env.LINES_TEST_GROK_REQUEST_SECRET ?? null,
      parentSecret: process.env.LINES_POISONED_PARENT_SECRET ?? null,
      subagents: process.env.GROK_SUBAGENTS ?? null,
      poisonedHookVisible: existsSync(
        `${process.env.GROK_HOME ?? ''}/hooks/poison.json`,
      ),
      compatDisabled: [
        'GROK_CLAUDE_SKILLS_ENABLED',
        'GROK_CLAUDE_RULES_ENABLED',
        'GROK_CLAUDE_AGENTS_ENABLED',
        'GROK_CLAUDE_MCPS_ENABLED',
        'GROK_CLAUDE_HOOKS_ENABLED',
        'GROK_CURSOR_SKILLS_ENABLED',
        'GROK_CURSOR_RULES_ENABLED',
        'GROK_CURSOR_AGENTS_ENABLED',
        'GROK_CURSOR_MCPS_ENABLED',
        'GROK_CURSOR_HOOKS_ENABLED',
      ].every((name) => process.env[name] === 'false'),
    },
  }));
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
  process.exit(0);
}

emit({
  type: 'system',
  subtype: 'init',
  session_id: 'fixture-session',
  model: effectiveModel,
  cwd: value('--cwd') ?? process.cwd(),
  permissionMode: value('--permission-mode') ?? 'default',
  tools: [
    ...(value('--tools') ?? '').split(',').filter(Boolean),
    ...(scenario === 'extra-capability' ? ['write_file'] : []),
  ],
  uuid: 'fixture-init',
});

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
  if (process.env.LINES_TEST_GROK_EFFECT) {
    writeFileSync(process.env.LINES_TEST_GROK_EFFECT, 'ran');
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

if (scenario === 'late-final') {
  process.stderr.write('transport closed after final result\n');
  process.exit(7);
}
