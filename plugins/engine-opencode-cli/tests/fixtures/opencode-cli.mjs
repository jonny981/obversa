#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);

function value(flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function emit(type, payload = {}) {
  process.stdout.write(`${JSON.stringify({
    type,
    timestamp: 1_777_777_777_777,
    sessionID: 'fixture-session',
    ...payload,
  })}\n`);
}

function markFinalWritten() {
  if (process.env.OBVERSA_TEST_OPENCODE_FINAL_MARKER) {
    writeFileSync(process.env.OBVERSA_TEST_OPENCODE_FINAL_MARKER, 'written');
  }
}

function textPart(id, text, overrides = {}) {
  return {
    id,
    sessionID: 'fixture-session',
    messageID: 'fixture-message',
    type: 'text',
    text,
    time: { start: 1, end: 2 },
    ...overrides,
  };
}

function finishPart(id, tokens = {}) {
  return {
    id,
    sessionID: 'fixture-session',
    messageID: 'fixture-message',
    type: 'step-finish',
    reason: 'stop',
    cost: 0,
    tokens: {
      input: 2,
      output: 5,
      reasoning: 2,
      cache: { read: 3, write: 1 },
      ...tokens,
    },
  };
}

function apiError(message, statusCode, isRetryable = false, extra = {}) {
  return {
    name: 'APIError',
    data: {
      message,
      statusCode,
      isRetryable,
      ...extra,
    },
  };
}

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;

const scenario = process.env.OBVERSA_ENGINE_CONFORMANCE_SCENARIO
  ?? process.env.OBVERSA_TEST_OPENCODE_SCENARIO
  ?? 'ordered-parts';
if (scenario === 'timeout-final' || scenario === 'timeout-final-structured') process.on('SIGTERM', () => {});
const recordPath = process.env.OBVERSA_TEST_OPENCODE_RECORD;

if (recordPath) {
  const config = process.env.OPENCODE_CONFIG_CONTENT ?? '';
  const auth = process.env.OPENCODE_AUTH_CONTENT ?? '';
  writeFileSync(recordPath, JSON.stringify({
    args,
    cwd: process.cwd(),
    prompt,
    attempt: {
      attemptId: process.env.OBVERSA_ATTEMPT_ID ?? null,
      runId: process.env.OBVERSA_RUN_ID ?? null,
      headless: process.env.OBVERSA_HEADLESS ?? null,
    },
    environment: {
      home: process.env.HOME ?? null,
      dataHome: process.env.XDG_DATA_HOME ?? null,
      configHome: process.env.XDG_CONFIG_HOME ?? null,
      cacheHome: process.env.XDG_CACHE_HOME ?? null,
      stateHome: process.env.XDG_STATE_HOME ?? null,
      temporary: process.env.TMPDIR ?? null,
      config,
      auth,
      selected: process.env.OBVERSA_TEST_OPENCODE_SELECTED ?? null,
      requestSecret: process.env.OBVERSA_TEST_OPENCODE_REQUEST_SECRET ?? null,
      parentSecret: process.env.OBVERSA_POISONED_PARENT_SECRET ?? null,
      projectConfigDisabled: process.env.OPENCODE_DISABLE_PROJECT_CONFIG ?? null,
      pure: process.env.OPENCODE_PURE ?? null,
      defaultPluginsDisabled: process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS ?? null,
      externalSkillsDisabled: process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS ?? null,
      claudeCodeDisabled: process.env.OPENCODE_DISABLE_CLAUDE_CODE ?? null,
      autoUpdateDisabled: process.env.OPENCODE_DISABLE_AUTOUPDATE ?? null,
      lspDownloadDisabled: process.env.OPENCODE_DISABLE_LSP_DOWNLOAD ?? null,
      shareDisabled: process.env.OPENCODE_DISABLE_SHARE ?? null,
      poisonedConfigVisible:
        existsSync(`${process.env.XDG_CONFIG_HOME ?? ''}/opencode/opencode.json`)
        && readFileSync(
          `${process.env.XDG_CONFIG_HOME}/opencode/opencode.json`,
          'utf8',
        ).includes('poison'),
    },
  }));
}

if (scenario === 'auth') {
  emit('error', {
    error: {
      name: 'ProviderAuthError',
      data: { providerID: 'fixture', message: 'authentication required' },
    },
  });
  process.exit(1);
}
if (scenario === 'auth-echo') {
  const auth = JSON.parse(process.env.OPENCODE_AUTH_CONTENT ?? '{}');
  emit('error', {
    error: {
      name: 'ProviderAuthError',
      data: {
        providerID: 'fixture',
        message: `authentication failed for ${auth.fixture.key}`,
      },
    },
  });
  process.exit(1);
}
if (scenario === 'protocol-auth-echo') {
  const auth = JSON.parse(process.env.OPENCODE_AUTH_CONTENT ?? '{}');
  emit(auth.fixture.key);
  process.exit(0);
}
if (scenario === 'environment-echo') {
  emit('error', {
    error: apiError(
      `request failed for ${process.env.OBVERSA_TEST_OPENCODE_SELECTED}`,
      500,
      true,
    ),
  });
  process.exit(1);
}
if (scenario === 'billing') {
  emit('error', { error: apiError('402 exhausted credit balance', 402) });
  process.exit(1);
}
if (scenario === 'billing-429') {
  emit('error', { error: apiError('429 exhausted credit balance', 429) });
  process.exit(1);
}
if (scenario === 'billing-401') {
  emit('error', {
    error: apiError('OpenCode provider request failed', 401, false, {
      responseBody: JSON.stringify({
        error: { name: 'CreditsError', message: 'Insufficient balance' },
      }),
    }),
  });
  process.exit(1);
}
if (scenario === 'quota-401') {
  emit('error', {
    error: apiError('OpenCode provider request failed', 401, false, {
      responseBody: JSON.stringify({
        error: { name: 'MonthlyLimitError', message: 'Monthly limit reached' },
      }),
    }),
  });
  process.exit(1);
}
if (scenario === 'ambiguous-403') {
  emit('error', {
    error: apiError('quota allowance reached', 403, false, {
      responseHeaders: { 'x-ratelimit-reset': '1777777999' },
    }),
  });
  process.exit(1);
}
if (scenario === 'ambiguous-429') {
  emit('error', { error: apiError('429 usage limit reached', 429, true) });
  process.exit(1);
}
if (scenario === 'monthly-429') {
  emit('error', { error: apiError('monthly quota exhausted', 429, true) });
  process.exit(1);
}
if (scenario === 'user-limit-401') {
  emit('error', {
    error: apiError('OpenCode provider request failed', 401, false, {
      responseBody: JSON.stringify({
        error: { name: 'UserLimitError', message: 'User limit reached' },
      }),
    }),
  });
  process.exit(1);
}
if (scenario === 'model-401') {
  emit('error', {
    error: apiError('OpenCode provider request failed', 401, false, {
      responseBody: JSON.stringify({
        error: { name: 'ModelError', message: 'Model is unavailable' },
      }),
    }),
  });
  process.exit(1);
}
if (scenario === 'model-unavailable') {
  emit('error', { error: apiError('unknown requested model', 404) });
  process.exit(1);
}
if (scenario === 'rate-limit') {
  emit('error', { error: apiError('429 rate limit reached', 429, true) });
  process.exit(1);
}
if (scenario === 'quota') {
  emit('error', {
    error: apiError('monthly usage limit reached', 403, false, {
      responseHeaders: { 'x-ratelimit-reset': '1777777999' },
    }),
  });
  process.exit(1);
}
if (scenario === 'transient') {
  emit('error', { error: apiError('503 service unavailable', 503, true) });
  process.exit(1);
}
if (scenario === 'timeout') {
  emit('error', { error: apiError('request timed out', 408, true) });
  process.exit(1);
}
if (scenario === 'invalid-config') {
  process.stdout.write('{"type":"text","truncated":');
  process.exit(1);
}
if (scenario === 'hang' || scenario === 'cancellation') {
  emit('text', { part: textPart('fixture-ready', 'fixture-ready') });
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}

if (scenario === 'malformed-line') {
  process.stdout.write('{"type":"text","truncated":\n');
  process.exit(0);
}
if (scenario === 'wrong-session') {
  emit('text', {
    part: textPart('fixture-answer', 'answer', {
      sessionID: 'different-session',
    }),
  });
  process.exit(0);
}
if (scenario === 'conflicting-duplicate') {
  emit('text', { part: textPart('fixture-answer', 'answer') });
  emit('text', { part: textPart('fixture-answer', 'changed') });
  process.exit(0);
}
if (scenario === 'no-final') {
  emit('step_start', {
    part: {
      id: 'fixture-step-start',
      sessionID: 'fixture-session',
      messageID: 'fixture-message',
      type: 'step-start',
    },
  });
  process.exit(0);
}
if (scenario === 'zero-exit-no-finish') {
  emit('text', { part: textPart('fixture-partial', 'partial answer') });
  process.exit(0);
}
if (
  scenario === 'content-filter-finish'
  || scenario === 'error-finish'
  || scenario === 'length-finish'
) {
  emit('text', { part: textPart('fixture-partial', 'partial answer') });
  emit('step_finish', {
    part: {
      ...finishPart('fixture-step-finish'),
      reason: scenario === 'content-filter-finish'
        ? 'content-filter'
        : scenario === 'length-finish'
          ? 'length'
          : 'error',
    },
  });
  process.exit(0);
}
if (scenario === 'empty-length-finish' || scenario === 'empty-stop-finish') {
  emit('step_finish', {
    part: {
      ...finishPart('fixture-step-finish'),
      reason: scenario === 'empty-length-finish' ? 'length' : 'stop',
    },
  });
  process.exit(0);
}
if (scenario === 'empty-stop-auth') {
  emit('step_finish', { part: finishPart('fixture-step-finish') });
  markFinalWritten();
  emit('error', { error: apiError('unauthorized', 401) });
  process.exit(1);
}

const structuredScenarios = new Map([
  ['structured-result', 'OBVERSA_STRUCTURED_RESULT_V1\n{"answer":42}'],
  ['structured', 'OBVERSA_STRUCTURED_RESULT_V1\n{"answer":42}'],
  ['structured-missing-marker', '{"answer":42}'],
  ['structured-middle-marker', 'before OBVERSA_STRUCTURED_RESULT_V1\n{"answer":42}'],
  ['structured-fence', 'OBVERSA_STRUCTURED_RESULT_V1\n```json\n{"answer":42}\n```'],
  ['structured-trailing', 'OBVERSA_STRUCTURED_RESULT_V1\n{"answer":42} trailing'],
  ['structured-two-values', 'OBVERSA_STRUCTURED_RESULT_V1\n{"answer":42}\n{"answer":43}'],
  ['structured-malformed', 'OBVERSA_STRUCTURED_RESULT_V1\n{"answer":'],
  ['timeout-final-structured', 'OBVERSA_STRUCTURED_RESULT_V1\n{"answer":42}'],
]);

if (structuredScenarios.has(scenario)) {
  if (scenario !== 'structured-result') {
    emit('text', { part: textPart('fixture-draft', 'draft') });
  }
  emit('text', {
    part: textPart('fixture-structured', structuredScenarios.get(scenario)),
  });
  emit('step_finish', { part: finishPart('fixture-step-finish') });
  markFinalWritten();
  if (scenario !== 'timeout-final-structured') process.exit(0);
  setInterval(() => {}, 1_000);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await new Promise(() => {});
}
if (scenario === 'structured-two-markers') {
  emit('text', {
    part: textPart(
      'fixture-structured-1',
      'OBVERSA_STRUCTURED_RESULT_V1\n{"answer":42}',
    ),
  });
  emit('text', {
    part: textPart(
      'fixture-structured-2',
      'OBVERSA_STRUCTURED_RESULT_V1\n{"answer":43}',
    ),
  });
  emit('step_finish', { part: finishPart('fixture-step-finish') });
  process.exit(0);
}

if (scenario === 'tool-events') {
  emit('tool_use', {
    part: {
      id: 'fixture-tool',
      sessionID: 'fixture-session',
      messageID: 'fixture-message',
      type: 'tool',
      callID: 'fixture-call',
      tool: 'read',
      state: {
        status: 'completed',
        input: { filePath: 'README.md' },
        output: 'contents',
        title: 'Read README.md',
        metadata: {},
        time: { start: 1, end: 2 },
      },
    },
  });
  emit('text', { part: textPart('fixture-answer', 'answer') });
  emit('step_finish', { part: finishPart('fixture-step-finish') });
  process.exit(0);
}
if (scenario === 'undeclared-tool') {
  emit('tool_use', {
    part: {
      id: 'fixture-tool-undeclared',
      sessionID: 'fixture-session',
      messageID: 'fixture-message',
      type: 'tool',
      callID: 'fixture-call-undeclared',
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: 'echo escaped' },
        output: 'escaped',
        title: 'Undeclared shell',
        metadata: {},
        time: { start: 1, end: 2 },
      },
    },
  });
  emit('text', { part: textPart('fixture-answer', 'answer') });
  process.exit(0);
}
if (scenario === 'edit-tool-aliases') {
  for (const [id, tool] of [
    ['fixture-write-tool', 'write'],
    ['fixture-patch-tool', 'apply_patch'],
  ]) {
    emit('tool_use', {
      part: {
        id,
        sessionID: 'fixture-session',
        messageID: 'fixture-message',
        type: 'tool',
        callID: `${id}-call`,
        tool,
        state: {
          status: 'completed',
          input: {},
          output: 'done',
          title: tool,
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
    });
  }
  emit('text', { part: textPart('fixture-answer', 'answer') });
  emit('step_finish', { part: finishPart('fixture-step-finish') });
  process.exit(0);
}
if (scenario === 'tool-error-then-final') {
  emit('tool_use', {
    part: {
      id: 'fixture-tool-error',
      sessionID: 'fixture-session',
      messageID: 'fixture-message',
      type: 'tool',
      callID: 'fixture-call',
      tool: 'read',
      state: {
        status: 'error',
        input: { filePath: 'missing' },
        error: 'not found',
        time: { start: 1, end: 2 },
      },
    },
  });
  emit('text', { part: textPart('fixture-answer', 'answer') });
  emit('step_finish', { part: finishPart('fixture-step-finish') });
  process.exit(0);
}

if (scenario === 'unknown-usage') {
  emit('text', { part: textPart('fixture-answer', 'answer') });
  emit('step_finish', {
    part: {
      ...finishPart('fixture-step-finish'),
      tokens: {},
    },
  });
  process.exit(0);
}
if (scenario === 'reported-usage') {
  emit('text', { part: textPart('fixture-answer', 'answer') });
  emit('step_finish', {
    part: finishPart('fixture-step-finish', {
      input: 5,
      output: 3,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }),
  });
  process.exit(0);
}
if (scenario === 'zero-usage') {
  emit('text', { part: textPart('fixture-answer', 'answer') });
  emit('step_finish', {
    part: finishPart('fixture-step-finish', {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }),
  });
  process.exit(0);
}
if (scenario === 'multi-usage') {
  emit('text', { part: textPart('fixture-answer', 'answer') });
  emit('step_finish', { part: finishPart('fixture-step-finish-1') });
  emit('step_finish', {
    part: finishPart('fixture-step-finish-1'),
  });
  emit('step_finish', {
    part: finishPart('fixture-step-finish-2', {
      input: 1,
      output: 2,
      reasoning: 1,
      cache: { read: 1, write: 0 },
    }),
  });
  process.exit(0);
}

if (scenario === 'late-partial' || scenario === 'clean-partial') {
  emit('step_start', {
    part: {
      id: 'fixture-step-start',
      sessionID: 'fixture-session',
      messageID: 'fixture-message',
      type: 'step-start',
    },
  });
  emit('text', { part: textPart('fixture-partial', 'partial answer') });
  emit('step_finish', {
    part: {
      ...finishPart('fixture-step-finish'),
      reason: 'tool-calls',
    },
  });
  if (scenario === 'late-partial') {
    process.stderr.write('transport closed during tool work\n');
    process.exit(7);
  }
  process.exit(0);
}
if (scenario === 'late-invalid-reason') {
  emit('text', { part: textPart('fixture-partial', 'partial answer') });
  emit('step_finish', {
    part: {
      ...finishPart('fixture-step-finish'),
      reason: 'invented-finish',
    },
  });
  process.stderr.write('transport closed after invalid finish\n');
  process.exit(7);
}
if (scenario === 'late-malformed-tool-step') {
  emit('text', { part: textPart('fixture-first', 'first answer') });
  emit('step_finish', { part: finishPart('fixture-step-finish-1') });
  emit('text', { part: textPart('fixture-partial', 'partial answer') });
  emit('step_finish', {
    part: {
      ...finishPart('fixture-step-finish-2'),
      reason: 'tool-calls',
      tokens: { input: 'invalid' },
    },
  });
  process.stderr.write('transport closed during malformed tool work\n');
  process.exit(7);
}

emit('step_start', {
  part: {
    id: 'fixture-step-start',
    sessionID: 'fixture-session',
    messageID: 'fixture-message',
    type: 'step-start',
  },
});
emit('text', { part: textPart('fixture-draft', 'draft') });
if (scenario === 'identical-duplicate') {
  emit('text', { part: textPart('fixture-draft', 'draft') });
}
emit('text', { part: textPart('fixture-answer', 'answer') });
emit('step_finish', { part: finishPart('fixture-step-finish') });
markFinalWritten();

if (scenario === 'late-final') {
  process.stderr.write('transport closed after final result\n');
  process.exit(7);
}
if (scenario === 'timeout-final') {
  setInterval(() => {}, 1_000);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await new Promise(() => {});
}
