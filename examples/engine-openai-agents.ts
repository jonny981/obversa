import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { Agent, Usage, tool, type Model } from '@openai/agents';
import { codex } from '@obversa/engine-codex-cli';
import { openaiAgent } from '@obversa/engine-openai-agents';
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
 * A writer built with the OpenAI Agents SDK, on a team built with Obversa.
 * The agent keeps its own instructions, model and tool: it saves the page
 * with the save_file tool it was built with. Codex reads each draft and tags
 * its findings. A block always goes back to the writer; otherwise a judge
 * decides whether another round runs, and the cap is the last word.
 */

// ── The OpenAI Agents SDK agent ─────────────────────────────────────────────

const saveFile = tool({
  name: 'save_file',
  description: 'Save the whole text of a file, at a path relative to the working directory.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, text: { type: 'string' } },
    required: ['path', 'text'],
    additionalProperties: false,
  },
  execute: async (input) => {
    const { path, text } = input as { path: string; text: string };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    return `saved ${path}`;
  },
});

// Offline, the model replays the turns recorded in writer.json, so the
// example runs with no key. `WRITER_MODEL=gpt-5` gives the agent that OpenAI
// model instead, with `OPENAI_API_KEY` set.
const liveModel = process.env.WRITER_MODEL;

const agent = new Agent({
  name: 'Page writer',
  instructions: 'You rewrite documentation pages so a person reads them once and knows what to do. Save the page with the save_file tool, then reply with the JSON the prompt asks for.',
  model: liveModel ?? replayedModel('writer.json'),
  tools: [saveFile],
});

// ── The team ────────────────────────────────────────────────────────────────

// The replayed model is an object, whose name the SDK does not expose, so
// the seat is told which model to record. A model name needs no option.
const writer = openaiAgent(agent, liveModel === undefined ? { model: 'replayed/replayed-writer' } : {});
const reader = codex('gpt-5.6-luna');
const judgeSeat = recordedJudge('judge.json');

const brief = briefFromFile('briefs/page.md');
const file = brief.files?.[0];
if (file === undefined) throw new Error('briefs/page.md names no file in its front matter');

const team = workflow('openai-agents-writer', {
  brief,
  roles: { write: writer, read: [reader] },
  stages: [
    stage('write', {
      agent: 'write',
      writes: file,
      reviewedBy: 'read',
      refine: judge(judgeSeat, { cap: 3 }),
      desc: 'Rewrite the page so a person reads it once and knows what to do. On a later round, change only the sentences the findings name.',
      gate: 'The reader finds nothing that fails, or the judge says the page holds for this use case.',
    }),
  ],
});

const result = await run(team, {
  recordTo: 'records/openai-agents-writer.jsonl',
  runId: 'openai-agents-writer',
  onEvent: (event) => console.log(formatEvent(event)),
});

const stages = (result.outcome.data ?? {}) as Record<string, Outcome | undefined>;
console.log(JSON.stringify({
  status: result.outcome.status,
  stop: stages.write?.summary,
}, null, 2));

// ── The offline model ───────────────────────────────────────────────────────

/**
 * A model that replays recorded turns, one per call, repeating the last. A
 * turn is either `{ "save": { "path", "text" } }`, a call to the save_file
 * tool, or `{ "text": "..." }`, the agent's reply.
 */
function replayedModel(path: string): Model {
  type Turn = { readonly save: { readonly path: string; readonly text: string } } | { readonly text: string };
  let turns: Promise<readonly Turn[]> | undefined;
  let calls = 0;
  return {
    async getResponse() {
      turns ??= readFile(path, 'utf8').then((text) => JSON.parse(text) as Turn[]);
      const list = await turns;
      const turn = list[Math.min(calls, list.length - 1)]!;
      calls += 1;
      const usage = new Usage({ requests: 1, inputTokens: 400, outputTokens: 120, totalTokens: 520 });
      return 'save' in turn
        ? {
            usage,
            output: [{ type: 'function_call', callId: `save-${calls}`, name: 'save_file', arguments: JSON.stringify(turn.save), status: 'completed' }],
          }
        : {
            usage,
            output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: turn.text }] }],
          };
    },
    getStreamedResponse() {
      throw new Error('the engine runs the agent without streaming, so the replayed model does not stream');
    },
  };
}
