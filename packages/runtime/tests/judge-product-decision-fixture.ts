import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { agentJob, createStoredCallbackClient, dag, fnJob, humanReview, judge, loop, person, revisionRequest, run, stage, workflow } from '../src/api.ts';
import type { AgentRequest, Job, TeamSeat } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';
import { openStoredRunFixtureStorage } from './stored-run-fixture.ts';

export type ProductCaller = 'workflow' | 'dag' | 'agent' | 'human' | 'person';
export interface ProductScenario {
  readonly choices: readonly string[];
  readonly cap: number;
  readonly brief?: string;
  readonly stageName?: string;
  readonly blockFirst?: boolean;
  /**
   * Two findings a round (one marked REAL, one a taste note) for two rounds,
   * then a pass; the judge acts on the REAL one and skips the other.
   */
  readonly perFinding?: boolean;
}
export interface ProductCall {
  readonly kind: 'writer' | 'reviewer' | 'judge' | 'downstream';
  readonly prompt?: string;
}
export function productCalls(cwd: string): ProductCall[] {
  const file = join(cwd, 'calls.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}
function seat(engine: MockEngine, model: string, tools: readonly string[] = []): TeamSeat {
  return { engine, identity: { adapter: 'mock', provider: 'mock', modelFamily: model, model, tools } };
}
export function productDecisionJob(kind: ProductCaller, cwd: string, scenario: ProductScenario): Job {
  const record = (call: ProductCall) => appendFileSync(join(cwd, 'calls.jsonl'), `${JSON.stringify(call)}\n`);
  const name = scenario.stageName ?? 'write';
  const writer = (prompt?: string) => {
    record({ kind: 'writer', ...(prompt !== undefined ? { prompt } : {}) });
    writeFileSync(join(cwd, 'page.md'), `draft ${productCalls(cwd).filter((call) => call.kind === 'writer').length}`);
    return { status: 'pass' as const, summary: 'wrote the page' };
  };
  const review = (prompt?: string) => {
    const reviews = productCalls(cwd).filter((call) => call.kind === 'reviewer').length;
    const first = reviews === 0;
    record({ kind: 'reviewer', ...(prompt !== undefined ? { prompt } : {}) });
    if (scenario.perFinding) {
      if (reviews >= 2) return { status: 'pass', summary: 'nothing left', findings: [] };
      return {
        status: 'revise', summary: 'Two findings',
        findings: [
          { severity: 'should-fix' as const, evidence: `REAL: the page must choose one audience (round ${reviews + 1})` },
          { severity: 'nice-to-have' as const, evidence: `taste: a warmer tone (round ${reviews + 1})` },
        ],
      };
    }
    return {
      status: 'revise', summary: 'Choose the audience',
      findings: [{ severity: scenario.blockFirst && first ? 'block' as const : 'should-fix' as const, evidence: 'The page must choose one audience.' }],
    };
  };
  const judgeEngine = new MockEngine((request: AgentRequest) => {
    const count = productCalls(cwd).filter((call) => call.kind === 'judge').length;
    record({ kind: 'judge', prompt: request.prompt });
    const answers: Record<string, unknown> = { stop_reason: { choice: scenario.choices[Math.min(count, scenario.choices.length - 1)] } };
    if (scenario.perFinding) {
      const { questions } = JSON.parse(request.prompt) as { questions: Record<string, { instructions: string; criteria: Record<string, string> }> };
      for (const [id, question] of Object.entries(questions)) {
        if ('act' in question.criteria) answers[id] = { choice: question.instructions.includes('REAL') ? 'act' : 'skip', reason: 'judged' };
      }
    }
    return JSON.stringify(answers);
  });
  const refine = judge(seat(judgeEngine, 'judge-mock'), { cap: scenario.cap });
  const interaction = { id: 'rich-review', responseSchema: {} };
  if (kind === 'agent') return agentJob({ label: name, model: 'writer-mock', prompt: 'Write the original page.', interaction,
    engine: new MockEngine((request) => {
      const first = productCalls(cwd).length === 0;
      record({ kind: 'writer', prompt: request.prompt });
      return first ? JSON.stringify({ interaction: { question: 'Which audience?', input: { draft: 'the original page' } } }) : 'revised page';
    }),
  });
  if (kind === 'human') return loop({ name: 'human', max: scenario.cap,
    body: agentJob({ engine: new MockEngine((request) => { record({ kind: 'writer', prompt: request.prompt }); return 'the original page'; }), model: 'writer-mock', prompt: 'Write the original page.', consumeFeedback: true }),
    review: humanReview('review', { question: 'Ready?', input: (ctx) => String(ctx.lastOutcome!.data), interaction }),
  });
  if (kind === 'person') return workflow('rich-input', { brief: 'Choose an audience.', roles: { editor: person('Which audience?', { interaction }) }, stages: [stage('choose', { input: 'editor' })] });

  if (kind === 'workflow') {
    return workflow('product-review', {
      brief: scenario.brief ?? 'Use case: a useful page for one audience.\n\nWrite the page.',
      roles: {
        writer: seat(new MockEngine((request) => JSON.stringify(writer(request.prompt))), 'writer-mock', ['Write']),
        reviewer: [seat(new MockEngine((request) => JSON.stringify(review(request.prompt))), 'reviewer-mock', ['Read'])],
      },
      stages: [stage(name, { agent: 'writer', writes: 'page.md', reviewedBy: 'reviewer', refine })],
    });
  }
  return dag({
    name: 'product-review',
    maxKickbacks: { [name]: refine },
    nodes: {
      [name]: agentJob({ label: name, model: 'writer-mock', prompt: 'Write the page.', consumeFeedback: true,
        engine: new MockEngine((request) => writer(request.prompt).summary) }),
      review: { needs: [name], acceptsKickbackTo: [name], desc: scenario.brief ?? 'Choose the audience', job: fnJob('review', async (ctx) => {
        // A review node reads what the judge skipped from its context.
        const result = review(ctx.skippedFindings?.map((skipped) => skipped.finding.evidence).join('\n'));
        if (result.status === 'pass') return { status: 'pass' as const };
        return revisionRequest({ target: name, reason: result.summary, findings: result.findings });
      }) },
      downstream: { needs: ['review'], job: fnJob('downstream', async () => {
        record({ kind: 'downstream' });
        return { status: 'pass' };
      }) },
    },
  });
}

if (process.argv[2] === '--product-decision-worker') {
  const [kind, directory, runId, cwd, recordTo, resume, wait, encoded] = process.argv.slice(3);
  if (!kind || !directory || !runId || !cwd || !recordTo || !encoded) throw new Error('missing product decision worker input');
  const callbacks = await createStoredCallbackClient(openStoredRunFixtureStorage('judge-product-decision', directory), runId);
  let reads = 0;
  const result = await run(productDecisionJob(kind as ProductCaller, cwd, JSON.parse(encoded) as ProductScenario), {
    cwd, recordTo, resume: resume === 'true', onCallback: wait === 'true' ? 'wait' : 'exit',
    callbacks: {
      ...callbacks,
      async history(requestId) {
        const events = await callbacks.history(requestId);
        reads += 1;
        if (wait === 'true' && reads >= 3) {
          const requested = events.find((event) => event.kind === 'callback-requested');
          if (requested?.kind === 'callback-requested') process.send?.({ waiting: requested.request });
        }
        return events;
      },
    },
  });
  process.send?.({ outcome: result.outcome });
}
