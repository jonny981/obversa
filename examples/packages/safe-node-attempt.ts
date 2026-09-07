import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import {
  finalResultPart,
  validateAgentResult,
  type AgentRequest,
  type AgentResultPart,
  type JsonValue,
} from '@obversa/runtime';
import { GrokCliEngine } from '@obversa/engine-grok-cli';
import { OpenCodeCliEngine } from '@obversa/engine-opencode-cli';

const STRUCTURED_RESULT_MARKER = 'OBVERSA_STRUCTURED_RESULT_V1\n';
const RESULT_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'number' } },
  required: ['answer'],
  additionalProperties: false,
} as const;

const GROK_FIXTURE = `#!/usr/bin/env node
if (process.argv.length === 3 && process.argv[2] === '--version') {
  process.stdout.write('grok 1.0.5\\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  text: '{"answer":42}',
  stopReason: 'end_turn',
  sessionId: 'example-session',
  requestId: 'example-request',
  usage: {
    input_tokens: 2,
    output_tokens: 5,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0
  },
  modelUsage: {
    'grok-4-example': {
      inputTokens: 2,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      modelCalls: 1
    }
  },
  structuredOutput: { answer: 42 }
}, null, 2) + '\\n');
`;

const OPENCODE_FIXTURE = `#!/usr/bin/env node
for await (const chunk of process.stdin) void chunk;
const base = {
  timestamp: 1777777777777,
  sessionID: 'example-session'
};
const emit = (type, part) => {
  process.stdout.write(JSON.stringify({ ...base, type, part }) + '\\n');
};
emit('text', {
  id: 'example-result',
  sessionID: 'example-session',
  messageID: 'example-message',
  type: 'text',
  text: 'OBVERSA_STRUCTURED_RESULT_V1\\n{"answer":42}',
  time: { start: 1, end: 2 }
});
emit('step_finish', {
  id: 'example-finish',
  sessionID: 'example-session',
  messageID: 'example-message',
  type: 'step-finish',
  reason: 'stop',
  cost: 0,
  tokens: {}
});
`;

function request(
  directory: string,
  model: string,
  jsonSchema: JsonValue,
): AgentRequest {
  return {
    prompt: 'Return the structured answer.',
    system: 'Follow the result contract.',
    model,
    jsonSchema,
    tools: [],
    allowedTools: [],
    cwd: directory,
    workspaceMode: 'none',
    leaf: true,
    timeoutMs: 5_000,
    timeoutGraceMs: 200,
    maxOutputBytes: 64 * 1_024,
    maxMemoryBytes: 256 * 1_024 * 1_024,
  };
}

function nativeValue(part: AgentResultPart): JsonValue {
  assert.equal(part.kind, 'structured');
  if (part.kind !== 'structured') throw new TypeError('Expected a structured result');
  return part.value;
}

function parsedValue(part: AgentResultPart): JsonValue {
  assert.equal(part.kind, 'assistant');
  if (part.kind !== 'assistant') throw new TypeError('Expected an assistant result');
  assert.ok(part.text.startsWith(STRUCTURED_RESULT_MARKER));
  return JSON.parse(part.text.slice(STRUCTURED_RESULT_MARKER.length)) as JsonValue;
}

const directory = await mkdtemp(join(tmpdir(), 'obversa-safe-attempt-'));
const grokExecutable = join(directory, 'grok-fixture.mjs');
const openCodeExecutable = join(directory, 'opencode-fixture.mjs');
let report;

try {
  await writeFile(grokExecutable, GROK_FIXTURE);
  await writeFile(openCodeExecutable, OPENCODE_FIXTURE);
  await chmod(grokExecutable, 0o700);
  await chmod(openCodeExecutable, 0o700);

  const grok = validateAgentResult(await new GrokCliEngine({
    executable: grokExecutable,
    version: '1.0.5',
    identity: { provider: 'xai', modelFamily: 'grok-4' },
    permissionMode: 'dontAsk',
  }).run(
    request(directory, 'grok-4-example', RESULT_SCHEMA),
    () => {},
    new AbortController().signal,
  ));

  const opencode = validateAgentResult(await new OpenCodeCliEngine({
    executable: openCodeExecutable,
    version: '1.18.23',
    identity: { provider: 'opencode', modelFamily: null },
  }).run(
    request(directory, 'opencode/x-preview-f-free', RESULT_SCHEMA),
    () => {},
    new AbortController().signal,
  ));

  const grokFinal = nativeValue(finalResultPart(grok));
  const openCodeFinal = parsedValue(finalResultPart(opencode));
  assert.deepEqual(grokFinal, { answer: 42 });
  assert.deepEqual(openCodeFinal, { answer: 42 });
  assert.equal(opencode.usage.kind, 'unknown');

  report = {
    grok: {
      requested: grok.requested,
      effective: grok.effective,
      final: grokFinal,
      usage: grok.usage.kind,
    },
    opencode: {
      requested: opencode.requested,
      effective: opencode.effective,
      final: openCodeFinal,
      usage: opencode.usage.kind,
    },
  };
} finally {
  await rm(directory, { recursive: true, force: true });
}

assert.ok(report);
export const attemptReport = {
  ...report,
  temporaryDirectoryRemoved: !existsSync(directory),
};
console.log(JSON.stringify(attemptReport, (key, value: unknown) => (
  key === 'executable' && typeof value === 'string'
    ? relative(directory, value)
    : value
), 2));
