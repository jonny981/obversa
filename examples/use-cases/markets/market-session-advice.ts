import { readdir, readFile, appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { claude } from '@obversa/engine-claude-cli';
import { JevApiEngine } from '@obversa/engine-jev-api';
import {
  agentJob,
  approval,
  dag,
  fnJob,
  formatEvent,
  predicate,
  run,
  type Engine,
  type JobContext,
  type Outcome,
} from '@obversa/runtime';
import { MockEngine } from '@obversa/runtime/testing';

/**
 * Scheduled market observations and advice, on recorded data. A session
 * host reads a fictional venue's calendar and the observations recorded for
 * each session. Every admitted observation is one recorded run: a typed
 * assessment, a check of its shape, research over the evidence files when
 * the assessment is uncertain, an advice record, and a question for a
 * person where action would be considered. The host never places an order
 * and never connects to a brokerage. Nothing here is a claim about returns.
 */

interface Session {
  readonly date: string;
  readonly open?: string;
  readonly close?: string;
  readonly closed?: boolean;
  readonly shortened?: boolean;
}

interface Observation {
  readonly id: string;
  readonly session: string;
  readonly symbol: string;
  readonly observedAt: string;
  readonly change: { readonly pricePercent: number; readonly volumeRatio: number };
  readonly evidence: readonly string[];
  readonly recordedAssessment: unknown;
}

interface Policy {
  readonly minConfidence: number;
  readonly minEvidenceProbability: number;
}

type Advice = 'hold' | 'consider-buy' | 'consider-sell';

interface Assessment {
  readonly advice: Advice;
  readonly confidence: number;
  readonly evidenceProbability: number;
  readonly researchCategory: string;
  readonly uncertain: boolean;
}

const ADVICE: readonly Advice[] = ['hold', 'consider-buy', 'consider-sell'];

/** The three questions, in the shape the Jev engine reads from the prompt. */
function assessmentPrompt(observation: Observation): string {
  return JSON.stringify({
    state: { symbol: observation.symbol, observedAt: observation.observedAt, change: observation.change },
    questions: {
      advice: {
        type: 'choice',
        instructions: 'Given this observation alone, what should a person consider?',
        criteria: {
          hold: 'Nothing in the observation calls for action',
          'consider-buy': 'The move looks overdone against the evidence on file',
          'consider-sell': 'The move looks justified and likely to continue',
        },
      },
      evidence: {
        type: 'noul',
        instructions: 'Does the supplied observation carry enough evidence for that advice?',
        criteria: { true: 'The move is explained by evidence on file', false: 'The move is unexplained or the evidence is thin' },
      },
      research: {
        type: 'choice',
        instructions: 'Which supplied evidence most needs a closer read?',
        criteria: { news: 'The news file', filings: 'The filings file', none: 'None' },
      },
    },
  });
}

/** Read the typed answers, or fail the step. A malformed answer never becomes advice. */
function readAssessment(text: string, policy: Policy): Assessment {
  const answers = JSON.parse(text) as Record<string, Record<string, unknown>>;
  const advice = answers.advice?.choice;
  const confidence = answers.advice?.confidence;
  const probability = answers.evidence?.probability;
  const category = answers.research?.choice;
  if (!ADVICE.includes(advice as Advice)) throw new Error(`advice is not one of ${ADVICE.join(', ')}: ${String(advice)}`);
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`confidence is not a number in [0, 1]: ${String(confidence)}`);
  }
  if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error(`evidence probability is not a number in [0, 1]: ${String(probability)}`);
  }
  return {
    advice: advice as Advice,
    confidence,
    evidenceProbability: probability,
    researchCategory: typeof category === 'string' ? category : 'none',
    uncertain: confidence < policy.minConfidence || probability < policy.minEvidenceProbability,
  };
}

const assessmentOf = (ctx: JobContext): Assessment => ctx.needs?.validate?.data as Assessment;

/** One observation, one recorded run. */
function observationRun(observation: Observation, policy: Policy) {
  const researchNote = `advice/${observation.id}-research.md`;
  return dag({
    name: `observation-${observation.id}`,
    nodes: {
      assess: agentJob({
        label: 'assess',
        engine: 'assess',
        workspaceMode: 'none',
        tools: [],
        leaf: true,
        prompt: () => assessmentPrompt(observation),
      }),
      validate: {
        needs: 'assess',
        job: fnJob('validate', (ctx): Outcome => {
          const assessment = readAssessment(String(ctx.needs?.assess?.data ?? ''), policy);
          return { status: 'pass', summary: `${assessment.advice} at ${assessment.confidence}`, data: assessment };
        }),
      },
      research: {
        needs: 'validate',
        when: predicate((ctx) => assessmentOf(ctx).uncertain, 'the assessment is uncertain'),
        job: agentJob({
          label: 'research',
          engine: 'research',
          prompt: (ctx) => [
            `Observation ${observation.id} of ${observation.symbol} at ${observation.observedAt}:`,
            `price ${observation.change.pricePercent}%, volume ${observation.change.volumeRatio}x the usual.`,
            `The assessment was uncertain and named "${assessmentOf(ctx).researchCategory}" as the evidence to read first.`,
            `Read only these files: ${observation.evidence.join(', ')}.`,
            `Follow briefs/market-session.md and write ${researchNote}.`,
          ].join('\n'),
        }),
      },
      record: {
        needs: ['validate', 'research'],
        job: fnJob('record', async (ctx): Promise<Outcome> => {
          const assessment = assessmentOf(ctx);
          const research = ctx.needs?.research;
          const researched = research?.status === 'pass' && !(research.data as { skipped?: boolean } | undefined)?.skipped;
          const advice = { observation: observation.id, ...assessment, researched, researchNote: researched ? researchNote : null };
          await mkdir('advice', { recursive: true });
          await writeFile(`advice/${observation.id}.json`, `${JSON.stringify(advice, null, 2)}\n`);
          return { status: 'pass', summary: `${assessment.advice}${researched ? ', researched' : ''}`, data: { advice: assessment.advice, researched } };
        }),
      },
      consider: {
        needs: 'record',
        when: predicate((ctx) => (ctx.needs?.record?.data as { advice: Advice }).advice !== 'hold', 'action would be considered'),
        job: approval('consider', {
          question: `Consider acting on ${observation.symbol} (${observation.id})?`,
        }),
      },
    },
  });
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

const calendar = await readJson<{ venue: string; sessions: readonly Session[] }>('sessions/calendar.json');
const policy = await readJson<Policy>('policy.json');

// The assessment seat is Jev when configured, and otherwise replays the
// assessment recorded with each observation, so the file runs offline.
const research = claude('claude-sonnet-4-5');
let assess: Engine;
let current: Observation | undefined;
if (process.env.MARKET_ASSESS_ENGINE === 'jev') {
  const endpoint = process.env.TYPESAFE_ENDPOINT;
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!endpoint || !apiKey) throw new Error('MARKET_ASSESS_ENGINE=jev needs TYPESAFE_ENDPOINT and TYPESAFE_API_KEY');
  assess = new JevApiEngine({ endpoint, apiKey });
} else {
  assess = new MockEngine(() => JSON.stringify(current?.recordedAssessment ?? null));
}

interface SessionReport {
  readonly date: string;
  readonly kind: 'ordinary' | 'closed' | 'shortened';
  readonly refused: { id: string; reason: string }[];
  readonly runs: { id: string; outcome: string; advice: string | null; researched: boolean; question: string | null }[];
}

const sessions: SessionReport[] = [];
await mkdir('history', { recursive: true });
for (const session of calendar.sessions) {
  const report: SessionReport = {
    date: session.date,
    kind: session.closed ? 'closed' : session.shortened ? 'shortened' : 'ordinary',
    refused: [],
    runs: [],
  };
  sessions.push(report);
  const directory = join('observations', session.date);
  const files = (await readdir(directory).catch(() => [] as string[])).filter((name) => name.endsWith('.json')).sort();
  for (const file of files) {
    const observation = await readJson<Observation>(join(directory, file));
    if (session.closed) {
      report.refused.push({ id: observation.id, reason: 'the venue is closed' });
      continue;
    }
    const open = Date.parse(`${session.date}T${session.open}:00Z`);
    const close = Date.parse(`${session.date}T${session.close}:00Z`);
    const at = Date.parse(observation.observedAt);
    if (at < open || at >= close) {
      report.refused.push({ id: observation.id, reason: at < open ? 'before the open' : 'after the close' });
      continue;
    }
    current = observation;
    const result = await run(observationRun(observation, policy), {
      engines: { assess, research: research.engine },
      recordTo: `records/${observation.id}.jsonl`,
      runId: observation.id,
      onEvent: (event) => console.log(formatEvent(event)),
    });
    const nodes = (result.outcome.data ?? {}) as Record<string, Outcome | undefined>;
    const recorded = nodes.record?.data as { advice: Advice; researched: boolean } | undefined;
    const question = result.outcome.status === 'paused' ? (nodes.consider?.data as { decisionText?: string } | undefined)?.decisionText ?? null : null;
    if (question) {
      await appendFile('history/questions.jsonl', `${JSON.stringify({ observation: observation.id, runId: observation.id, question })}\n`);
    }
    report.runs.push({
      id: observation.id,
      outcome: result.outcome.status,
      advice: recorded?.advice ?? null,
      researched: recorded?.researched ?? false,
      question,
    });
  }
}

console.log(JSON.stringify({
  status: 'pass',
  venue: calendar.venue,
  sessions,
  pendingQuestions: sessions.flatMap((session) => session.runs).filter((entry) => entry.question !== null).length,
}, null, 2));
