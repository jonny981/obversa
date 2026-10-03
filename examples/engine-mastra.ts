import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { Agent } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import { createTool } from '@mastra/core/tools';
import { codex } from '@obversa/engine-codex-cli';
import { mastra } from '@obversa/engine-mastra';
import {
  briefFromFile,
  formatEvent,
  judge,
  run,
  stage,
  workflow,
  type Outcome,
} from '@obversa/runtime';
import { recordedJudge } from '@obversa/runtime/testing';

/**
 * A writer built with Mastra, on a team built with Obversa. The Mastra agent
 * keeps its own instructions, model and tool: it saves the page with the
 * saveFile tool it was built with. Codex reads each draft and tags its
 * findings. A block always goes back to the writer; otherwise a judge decides
 * whether another round runs, until it stops the rounds or the review passes.
 */

// ── The Mastra agent ────────────────────────────────────────────────────────

const saveFile = createTool({
  id: 'save-file',
  description: 'Save the whole text of a file, at a path relative to the working directory.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, text: { type: 'string' } },
    required: ['path', 'text'],
    additionalProperties: false,
  },
  execute: async (input) => {
    const { path, text } = input as { path: string; text: string };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    return { saved: path };
  },
});

const agent = new Agent({
  id: 'page-writer',
  name: 'Page writer',
  instructions: 'You rewrite documentation pages so a person reads them once and knows what to do. Save the page with the saveFile tool, then reply with the JSON the prompt asks for.',
  // Offline, the model replays the turns recorded in writer.json, so the
  // example runs with no key. `WRITER_MODEL=anthropic/claude-sonnet-4-5`
  // gives the agent that model instead, with the provider's key set.
  model: process.env.WRITER_MODEL ?? replayedModel('writer.json'),
  tools: { saveFile },
});

// ── The team ────────────────────────────────────────────────────────────────

const writer = mastra(agent);
const reader = codex('gpt-5.6-luna');
const judgeSeat = recordedJudge('judge.json');

const brief = briefFromFile('briefs/page.md');
const file = brief.files?.[0];
if (file === undefined) throw new Error('briefs/page.md names no file in its front matter');

const team = workflow('mastra-writer', {
  brief,
  roles: { write: writer, read: [reader] },
  stages: [
    stage('write', {
      agent: 'write',
      writes: file,
      reviewedBy: 'read',
      refine: judge(judgeSeat),
      desc: 'Rewrite the page so a person reads it once and knows what to do. On a later round, change only the sentences the findings name.',
      gate: 'The reader finds nothing that fails, or the judge says the page holds for this use case.',
    }),
  ],
});

const result = await run(team, {
  recordTo: 'records/mastra-writer.jsonl',
  runId: 'mastra-writer',
  onEvent: (event) => console.log(formatEvent(event)),
});

const stages = (result.outcome.data ?? {}) as Record<string, Outcome | undefined>;
console.log(JSON.stringify({
  status: result.outcome.status,
  stop: stages.write?.summary,
}, null, 2));

// ── The offline model ───────────────────────────────────────────────────────

/**
 * A language model that replays recorded turns, one per call, repeating the
 * last. A turn is either `{ "save": { "path", "text" } }`, a call to the
 * saveFile tool, or `{ "text": "..." }`, the agent's reply.
 */
function replayedModel(path: string): MastraModelConfig {
  type Turn = { readonly save: { readonly path: string; readonly text: string } } | { readonly text: string };
  let turns: Promise<readonly Turn[]> | undefined;
  let calls = 0;
  return {
    specificationVersion: 'v2',
    provider: 'replayed',
    modelId: 'replayed-writer',
    supportedUrls: {},
    async doGenerate() {
      turns ??= readFile(path, 'utf8').then((text) => JSON.parse(text) as Turn[]);
      const list = await turns;
      const turn = list[Math.min(calls, list.length - 1)]!;
      calls += 1;
      const usage = { inputTokens: 400, outputTokens: 120, totalTokens: 520 };
      return 'save' in turn
        ? {
            content: [{ type: 'tool-call', toolCallId: `save-${calls}`, toolName: 'saveFile', input: JSON.stringify(turn.save) }],
            finishReason: 'tool-calls',
            usage,
            warnings: [],
          }
        : { content: [{ type: 'text', text: turn.text }], finishReason: 'stop', usage, warnings: [] };
    },
    async doStream() {
      throw new Error('the engine calls generate, so the replayed model does not stream');
    },
  };
}
