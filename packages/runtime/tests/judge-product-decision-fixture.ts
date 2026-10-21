import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { agentJob, createStoredCallbackClient, dag, fnJob, humanReview, judge, loop, person, review as buildReview, revisionRequest, run, stage, workflow } from '../src/api.ts';
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
  /**
   * With `perFinding`: round 1 raises two REAL findings (two acts), round 2
   * one REAL and a taste note (one act — a count falling from the round
   * before), and every round after one REAL, so the run is still open when
   * a granted round's review arrives.
   */
  readonly falling?: boolean;
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
      if (scenario.falling) {
        if (reviews === 0) {
          return {
            status: 'revise', summary: 'Two findings',
            findings: [
              { severity: 'should-fix' as const, evidence: 'REAL: the page must choose one audience (round 1)' },
              { severity: 'should-fix' as const, evidence: 'REAL: the page must say where to run it (round 1)' },
            ],
          };
        }
        if (reviews === 1) {
          return {
            status: 'revise', summary: 'Two findings',
            findings: [
              { severity: 'should-fix' as const, evidence: `REAL: the page must choose one audience (round ${reviews + 1})` },
              { severity: 'nice-to-have' as const, evidence: `taste: a warmer tone (round ${reviews + 1})` },
            ],
          };
        }
        return {
          status: 'revise', summary: 'One finding',
          findings: [{ severity: 'should-fix' as const, evidence: `REAL: the page must choose one audience (round ${reviews + 1})` }],
        };
      }
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
    const { questions } = JSON.parse(request.prompt) as { questions: Record<string, { type: string; instructions: string }> };
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(questions)) {
      if (!id.startsWith('finding-')) continue;
      answers[id] = { score: question.instructions.includes('REAL') ? 2 : 0, confidence: 0.95, reason: 'judged' };
    }
    // With per-finding judging the scores go in their own call first; a
    // scenario's choices are still one per round — the call that asks the
    // round questions reads the next one, and is the one the log records.
    if (!Object.keys(questions).some((id) => !id.startsWith('finding-'))) {
      return JSON.stringify(answers);
    }
    const count = productCalls(cwd).filter((call) => call.kind === 'judge').length;
    record({ kind: 'judge', prompt: request.prompt });
    const choice = scenario.choices[Math.min(count, scenario.choices.length - 1)];
    // A scenario's 'product_decision' is the noul, not a stop choice: the
    // judge answers it true and lets the round continue past its ask.
    return JSON.stringify(choice === 'product_decision'
      ? { ...answers, product_decision: { noul: 0.9 }, stop_reason: { choice: 'continue', confidence: 0.95 } }
      : { ...answers, product_decision: { noul: 0.05 }, stop_reason: { choice, confidence: 0.95 } });
  });
  const refine = judge(seat(judgeEngine, 'judge-mock'), { cap: scenario.cap, perFinding: scenario.perFinding === true });
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
    nodes: {
      [name]: {
        refine: buildReview({ judge: refine }),
        job: agentJob({ label: name, model: 'writer-mock', prompt: 'Write the page.', consumeFeedback: true,
          engine: new MockEngine((request) => writer(request.prompt).summary) }),
      },
      review: { needs: [name], sendsBackTo: [name], desc: scenario.brief ?? 'Choose the audience', job: fnJob('review', async (ctx) => {
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
