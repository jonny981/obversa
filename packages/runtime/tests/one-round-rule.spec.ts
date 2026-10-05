/**
 * The same intent, written as a reviewed `workflow()` stage, as a `dag()`
 * (a writer node, a review node and `maxKickbacks`) and, where it applies, as
 * a `loop()` with a graph body, behaves the same: the same outcome, the same
 * number of builds, the same judge consultations and the same judge input.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { agentJob, approval, createStoredCallbackClient, dag, exitCodeFor, fnJob, goalCheck, judge, kickback, loop, LoopError, person, reviewPanel, revisionRequest, run, stage, workflow } from '../src/api.ts';
import type { AgentRequest, InteractionBinding, InteractionResponse, Job, LoopEvent, Outcome, RunResult, StoredCallbackClient, TeamSeat, WorkflowRole } from '../src/api.ts';
import { outcomeFromAgentText } from '../src/workflow-agent-response.ts';
import { MockEngine } from '../src/testing.ts';
import { cleanupRepos, tmpRepo } from './git-helpers.ts';
import { createStoredRunFixture, type StoredRunFixture } from './stored-run-fixture.ts';

const dirs: string[] = [];
const stores: StoredRunFixture[] = [];
afterEach(async () => {
  cleanupRepos();
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'one-round-rule-'));
  dirs.push(dir);
  return dir;
}

function seat(engine: MockEngine, model: string, tools: readonly string[] = []): TeamSeat {
  return { engine, identity: { adapter: 'mock', provider: 'mock', modelFamily: model, model, tools } };
}

const BRIEF = 'Use case: a reader gets a clear, short page.\n\nWrite the page.';

type Form = 'workflow' | 'dag' | 'loop';

/** Scripted replies, one per call; the last one repeats. */
function scripted(replies: readonly unknown[], calls: string[], timeouts: (number | undefined)[] = []) {
  return new MockEngine((req: AgentRequest) => {
    const reply = replies[Math.min(calls.length, replies.length - 1)];
    calls.push(req.prompt);
    timeouts.push(req.timeoutMs);
    return JSON.stringify(typeof reply === 'function' ? (reply as (prompt: string) => unknown)(req.prompt) : reply);
  });
}

interface Intent {
  /** One list of replies per reviewer, by round. */
  readonly reviews: readonly (readonly unknown[])[];
  /** A number of refinements, or a judge's options and replies. */
  readonly refine: number | { readonly cap?: number; readonly replies: readonly unknown[]; readonly interaction?: InteractionBinding };
  /** Reviewers that must pass for the round to pass; every one by default. */
  readonly agree?: number;
  /** The writer leaves the page as it was after the first draft. */
  readonly unchanged?: boolean;
  /** The writer also writes a scratch file that differs on every build. */
  readonly scratch?: boolean;
  /** A goal check before the reviews, scripted by round. */
  readonly goal?: readonly unknown[];
  /** A person reviews instead of a panel: each answer is a refusal note, or null to approve. */
  readonly person?: readonly (string | null)[];
  /** The time limit of the node that holds the review. */
  readonly timeoutMs?: number;
  /** A later step that sends the work back too, scripted by call. */
  readonly approve?: readonly { readonly status: string; readonly summary: string; readonly findings?: readonly unknown[] }[];
}

interface Built {
  readonly job: Job;
  readonly writer: string[];
  readonly reviewer: string[];
  readonly judge: string[];
  readonly judgeTimeouts: (number | undefined)[];
  readonly goal: string[];
}

/** The same intent, in the form asked for. */
function build(form: Form, intent: Intent): Built {
  const calls = { writer: [] as string[], reviewer: [] as string[], judge: [] as string[], judgeTimeouts: [] as (number | undefined)[], goal: [] as string[] };
  const writerEngine = new MockEngine((req: AgentRequest) => {
    calls.writer.push(req.prompt);
    const draft = intent.unchanged ? 'draft' : `draft ${calls.writer.length}`;
    writeFileSync(join(req.cwd!, 'page.md'), draft);
    if (intent.scratch) writeFileSync(join(req.cwd!, 'scratch.md'), `notes ${calls.writer.length}`);
    // A person's approval is asked again only about new work, so the
    // summary names the draft.
    return JSON.stringify({ status: 'pass', summary: `wrote ${draft}` });
  });
  const reviewers = intent.reviews.map((replies, index) => {
    const own: string[] = [];
    const engine = new MockEngine((req: AgentRequest) => {
      const reply = replies[Math.min(own.length, replies.length - 1)];
      own.push(req.prompt);
      calls.reviewer.push(req.prompt);
      return JSON.stringify(reply);
    });
    return { name: `write-${index + 1}`, seat: seat(engine, `reviewer-${index + 1}`, ['Read']), engine };
  });
  const judgeOf = typeof intent.refine === 'number' ? undefined : intent.refine;
  const refine = judgeOf === undefined
    ? intent.refine as number
    : judge(seat(scripted(judgeOf.replies, calls.judge, calls.judgeTimeouts), 'judge-mock'), {
      ...(judgeOf.cap !== undefined ? { cap: judgeOf.cap } : {}),
      ...(judgeOf.interaction ? { interaction: judgeOf.interaction } : {}),
    });
  const goalSeat = intent.goal ? seat(scripted(intent.goal, calls.goal), 'goal-mock', ['Read']) : undefined;
  const answers = [...(intent.person ?? [])];
  const nextAnswer = () => answers.length > 1 ? answers.shift()! : answers[0]!;
  let approvals = 0;
  const approve = fnJob('approve', () => {
    const reply = intent.approve![Math.min(approvals++, intent.approve!.length - 1)]!;
    return reply.status === 'pass'
      ? reply.summary
      : revisionRequest({ target: 'write', reason: reply.summary, findings: reply.findings as typeof FINDING[] });
  });

  if (form === 'workflow') {
    const reviewerRole: WorkflowRole = intent.person
      ? person('Is the page ready?', {
        interaction: {
          id: 'page-review',
          responseSchema: { type: 'object' },
          async answer() {
            const note = nextAnswer();
            calls.reviewer.push(note ?? 'approved');
            return note === null
              ? { feedback: {}, decision: 'approved', prompt: 'Ready.' }
              : { feedback: {}, decision: 'changes-requested', prompt: note };
          },
        },
      })
      : reviewers.map((reviewer) => reviewer.seat);
    return {
      ...calls,
      job: workflow('page', {
        brief: BRIEF,
        ...(intent.timeoutMs !== undefined ? { options: { timeout: intent.timeoutMs } } : {}),
        roles: { writer: seat(writerEngine, 'writer-mock', ['Write']), reviewer: reviewerRole },
        stages: [stage('write', {
          agent: 'writer',
          writes: 'page.md',
          reviewedBy: 'reviewer',
          refine,
          ...(intent.agree !== undefined ? { agree: intent.agree } : {}),
          ...(goalSeat ? { goal: goalSeat } : {}),
        }), ...(intent.approve ? [stage('approve', { fn: approve, sendsBackTo: 'write' })] : [])],
      }),
    };
  }

  const writer = agentJob({
    label: 'write',
    engine: writerEngine,
    model: 'writer-mock',
    workspaceMode: 'write',
    consumeFeedback: true,
    prompt: 'Write page.md.',
    outcome: (text) => outcomeFromAgentText(text),
  });
  const panel = (target?: string): Job => reviewPanel({
    label: 'write',
    ...(target !== undefined ? { target } : {}),
    ...(intent.agree !== undefined ? { pass: intent.agree } : {}),
    reviewers: reviewers.map((reviewer) => ({
      name: reviewer.name,
      job: agentJob({
        label: reviewer.name,
        engine: reviewer.engine,
        model: reviewer.seat.identity.model,
        workspaceMode: 'read',
        tools: ['Read'],
        prompt: 'Review page.md.',
        outcome: (text) => outcomeFromAgentText(text),
      }),
    })),
  });

  if (form === 'loop') {
    if (typeof refine !== 'number') throw new Error('a loop takes no judge');
    return {
      ...calls,
      job: loop({ name: 'page', max: refine + 1, body: dag({ name: 'build', nodes: { write: { job: writer, file: 'page.md' } } }), review: panel() }),
    };
  }

  const review: Job = intent.person
    ? approval('review', {
      question: 'Is the page ready?',
      target: 'write',
      answer: () => {
        const note = nextAnswer();
        calls.reviewer.push(note ?? 'approved');
        return note === null ? { approved: true } : { approved: false, note };
      },
    })
    : panel('write');
  return {
    ...calls,
    job: dag({
      name: 'page',
      useCase: 'a reader gets a clear, short page.',
      maxKickbacks: { write: refine },
      nodes: {
        write: { job: writer, file: 'page.md' },
        ...(goalSeat ? { goal: { needs: 'write', job: goalCheck(goalSeat, { target: 'write', text: BRIEF }), acceptsKickbackTo: ['write'] } } : {}),
        review: {
          needs: goalSeat ? 'goal' : 'write',
          job: review,
          acceptsKickbackTo: ['write'],
          ...(intent.timeoutMs !== undefined ? { timeoutMs: intent.timeoutMs } : {}),
        },
        ...(intent.approve ? { approve: { needs: 'review', job: approve, acceptsKickbackTo: ['write'] } } : {}),
      },
    }),
  };
}

/** The node whose verdict ends the work: the stage in a workflow, the review node in a dag, the loop itself. */
function verdict(form: Form, result: RunResult): Outcome {
  const data = result.outcome.data as Record<string, Outcome> | undefined;
  if (form === 'workflow') return data!.write!;
  if (form === 'dag') return data!.review ?? data!.write!;
  return result.outcome;
}

/** Everything the judge reads. */
function judgeInput(prompt: string): Record<string, unknown> {
  return (JSON.parse(prompt) as { state: Record<string, unknown> }).state;
}

async function runForm(form: Form, intent: Intent) {
  const built = build(form, intent);
  const events: LoopEvent[] = [];
  const result = await run(built.job, { cwd: workDir(), onEvent: (event) => events.push(event) });
  return { ...built, result, events, verdict: verdict(form, result) };
}

/** Run every form, check each against `expected`, and check they agree on the judge's input. */
async function sameInEveryForm(forms: readonly Form[], intent: Intent, expected: {
  readonly status: Outcome['status'];
  readonly builds: number;
  readonly judged?: number;
}) {
  const runs = [];
  for (const form of forms) {
    const ran = await runForm(form, intent);
    expect(ran.result.outcome.status, `${form}: outcome`).toBe(expected.status);
    expect(exitCodeFor(ran.result.outcome), `${form}: exit code`).toBe(exitCodeFor({ status: expected.status }));
    expect(ran.writer, `${form}: builds`).toHaveLength(expected.builds);
    expect(ran.judge, `${form}: judge consultations`).toHaveLength(expected.judged ?? 0);
    runs.push({ form, ...ran });
  }
  const [first, ...rest] = runs;
  for (const other of rest) {
    expect(other.judge.map(judgeInput), `${other.form} judge input`).toEqual(first!.judge.map(judgeInput));
  }
  return runs;
}

const FINDING = { severity: 'should-fix', evidence: 'the title is vague' } as const;
const REVISE = { status: 'revise', summary: 'one finding', findings: [FINDING] };
const PASS = { status: 'pass', summary: 'nothing to add' };

const REAL = { severity: 'block', evidence: 'REAL: the page never says who it is for' } as const;
const TASTE = { severity: 'nice-to-have', evidence: 'taste: prefer a warmer tone' } as const;

/** Act on a finding marked REAL and skip the rest; `round` holds the round answers. */
function perFinding(round: Record<string, unknown> = { stop_reason: { choice: 'continue' } }) {
  return (prompt: string) => {
    const { questions } = JSON.parse(prompt) as { questions: Record<string, { instructions: string; criteria: Record<string, string> }> };
    const answers: Record<string, unknown> = { ...round };
    for (const [key, question] of Object.entries(questions)) {
      if (!('act' in question.criteria)) continue;
      answers[key] = question.instructions.includes('REAL')
        ? { choice: 'act', reason: 'a reader cannot tell who the page is for' }
        : { choice: 'skip', reason: 'a matter of taste' };
    }
    return answers;
  };
}

describe('the same intent in every form', () => {
  it('refine: 2 that runs out is three builds, and fails with the last findings', async () => {
    const runs = await sameInEveryForm(['workflow', 'dag', 'loop'], { reviews: [[REVISE]], refine: 2 }, { status: 'fail', builds: 3 });
    for (const { form, verdict: outcome } of runs) {
      expect(outcome.revision?.findings?.map((f) => f.evidence), form).toEqual([FINDING.evidence]);
    }
  });

  it('refine: 0 is one build and no second', async () => {
    const runs = await sameInEveryForm(['workflow', 'dag', 'loop'], { reviews: [[REVISE]], refine: 0 }, { status: 'fail', builds: 1 });
    for (const { form, verdict: outcome } of runs) {
      expect(outcome.revision?.findings?.map((f) => f.evidence), form).toEqual([FINDING.evidence]);
    }
  });

  it('a judge with no cap lets the work stand when it says it holds', async () => {
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[REVISE]],
      refine: { replies: [{ stop_reason: { choice: 'continue' } }, { stop_reason: { choice: 'holds' } }] },
    }, { status: 'pass', builds: 2, judged: 2 });
    for (const { form, judge: prompts, events } of runs) {
      expect(judgeInput(prompts[0]!), form).toMatchObject({ round: 1, rounds: [], limit: expect.stringContaining('No round limit') });
      // The judge reads what the work is for and the file it reviews.
      expect(judgeInput(prompts[0]!), form).toMatchObject({ useCase: 'a reader gets a clear, short page.', file: 'page.md', draft: 'draft 1' });
      expect(judgeInput(prompts[1]!), form).toMatchObject({ draft: 'draft 2', rounds: [{ round: 1, changedLines: 1 }] });
      expect(judgeInput(prompts[1]!), form).toMatchObject({ round: 2, rounds: [{ round: 1 }] });
      // The record names the target and the round of each judge decision.
      const judged = events.filter((e): e is Extract<LoopEvent, { kind: 'refine:judge' }> => e.kind === 'refine:judge');
      expect(judged.map((e) => ({ target: e.target, round: e.round })), form).toEqual([{ target: 'write', round: 1 }, { target: 'write', round: 2 }]);
    }
  });

  it('not_converging fails the work with the last findings and the judge\'s reason', async () => {
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[REVISE]],
      refine: { replies: [{ stop_reason: { choice: 'continue' } }, { stop_reason: { choice: 'not_converging' } }] },
    }, { status: 'fail', builds: 2, judged: 2 });
    for (const { form, verdict: outcome } of runs) {
      expect(outcome.status, form).toBe('fail');
      expect(outcome.summary, form).toContain('the judge chose not_converging');
      expect(outcome.revision?.findings?.map((f) => f.evidence), form).toEqual([FINDING.evidence]);
    }
  });

  it('a cap of 1 allows one refinement, and the judge answers the last round', async () => {
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[REVISE]],
      refine: { cap: 1, replies: [{ stop_reason: { choice: 'continue' } }] },
    }, { status: 'fail', builds: 2, judged: 2 });
    for (const { form, judge: prompts, verdict: outcome } of runs) {
      expect(judgeInput(prompts[0]!), form).not.toHaveProperty('lastRound');
      expect(judgeInput(prompts[1]!), form).toMatchObject({ round: 2, cap: 1, lastRound: true });
      expect(outcome.summary, form).toContain('the cap of 1');
      expect(outcome.revision?.findings?.map((f) => f.evidence), form).toEqual([FINDING.evidence]);
    }
  });

  it('a judge that says the last round holds lets the work stand with its findings open', async () => {
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[REVISE]],
      refine: { cap: 1, replies: [{ stop_reason: { choice: 'continue' } }, { stop_reason: { choice: 'holds' } }] },
    }, { status: 'pass', builds: 2, judged: 2 });
    for (const { form, result } of runs) {
      const data = result.outcome.data as Record<string, Outcome>;
      const stood = form === 'workflow' ? data.write! : data.review!;
      expect(stood.openFindings?.map((f) => f.evidence), form).toEqual([FINDING.evidence]);
    }
  });

  it('a block the judge acts on goes back to the writer, and what it skipped reaches the next reviewers', async () => {
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[{ status: 'revise', summary: 'two findings', findings: [REAL, TASTE] }, PASS]],
      refine: { replies: [perFinding()] },
    }, { status: 'pass', builds: 2, judged: 1 });
    for (const { form, writer, reviewer } of runs) {
      expect(writer[1], form).toContain(REAL.evidence);
      expect(writer[1], form).not.toContain(TASTE.evidence);
      expect(reviewer[1], form).toContain(TASTE.evidence);
      expect(reviewer[1], form).toContain('a matter of taste');
    }
  });

  it('a goal check\'s unmet requirement goes back without the reviews or the judge, and counts as a round', async () => {
    const unmet = { requirements: [{ requirement: 'Says who it is for', verdict: 'unmet', evidence: 'no audience' }] };
    const met = { requirements: [{ requirement: 'Says who it is for', verdict: 'met', evidence: 'line 1' }] };
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[REVISE, PASS]],
      goal: [unmet, met],
      refine: { cap: 2, replies: [{ stop_reason: { choice: 'continue' } }] },
    }, { status: 'pass', builds: 3, judged: 1 });
    for (const { form, judge: prompts, reviewer } of runs) {
      expect(reviewer, form).toHaveLength(2);
      expect(judgeInput(prompts[0]!), form).toMatchObject({ round: 2, cap: 2, rounds: [] });
    }
  });

  it('a goal check that is never met runs out of refinements like a review', async () => {
    const unmet = { requirements: [{ requirement: 'Says who it is for', verdict: 'unmet', evidence: 'no audience' }] };
    await sameInEveryForm(['workflow', 'dag'], { reviews: [[PASS]], goal: [unmet], refine: 1 }, { status: 'fail', builds: 2 });
  });

  it('a product decision answered before the cap goes to the writer, and the judge sees it next round', async () => {
    const interaction: InteractionBinding = {
      id: 'product-decision',
      responseSchema: { type: 'object' },
      async answer() { return { feedback: { audience: 'new users' }, prompt: 'Write for new users.' }; },
    };
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[REVISE]],
      refine: { cap: 3, interaction, replies: [{ stop_reason: { choice: 'product_decision' } }, { stop_reason: { choice: 'holds' } }] },
    }, { status: 'pass', builds: 2, judged: 2 });
    for (const { form, writer, judge: prompts } of runs) {
      expect(writer[1], form).toContain('Write for new users.');
      expect(judgeInput(prompts[1]!), form).toMatchObject({ round: 2, productFeedback: [{ prompt: 'Write for new users.' }] });
    }
  });

  it('a person reviewer with a judge consults the judge on each refusal', async () => {
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [],
      person: ['Say who the page is for.', null],
      refine: { replies: [{ stop_reason: { choice: 'continue' } }] },
    }, { status: 'pass', builds: 2, judged: 1 });
    for (const { form, judge: prompts, writer } of runs) {
      expect(judgeInput(prompts[0]!), form).toMatchObject({ round: 1, latestFindings: [{ severity: 'block', evidence: 'Say who the page is for.' }] });
      expect(writer[1], form).toContain('Say who the page is for.');
    }
  });

  it.each([
    { name: 'a writer that returns the reviewed work unchanged after feedback fails at once', scratch: false },
    { name: 'a writer that leaves its declared file as it was fails at once, whatever else it writes', scratch: true },
  ])('$name', async ({ scratch }) => {
    const runs = await sameInEveryForm(['workflow', 'dag', 'loop'], { reviews: [[REVISE]], refine: 3, unchanged: true, scratch }, { status: 'fail', builds: 2 });
    for (const { form, result, writer } of runs) {
      expect(writer[1], form).toContain(FINDING.evidence);
      expect(result.outcome.summary, form).toContain('write returned the reviewed work unchanged after feedback');
    }
  });

  it('agree: 2 of 3 passes a round two reviewers pass', async () => {
    await sameInEveryForm(['workflow', 'dag', 'loop'], {
      reviews: [[PASS], [PASS], [REVISE]],
      agree: 2,
      refine: 1,
    }, { status: 'pass', builds: 1 });
  });

  it('a later step\'s send-back shares the refinements the stage\'s own reviews used', async () => {
    await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[REVISE, PASS]],
      approve: [REVISE],
      refine: 1,
    }, { status: 'fail', builds: 2 });
  });

  it('a later step\'s send-back counts on from the stage\'s own rounds, and the judge reads every round', async () => {
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[{ status: 'revise', summary: 'two findings', findings: [REAL, TASTE] }, PASS]],
      approve: [{ status: 'revise', summary: 'one finding', findings: [REAL] }, PASS],
      refine: { cap: 2, replies: [perFinding()] },
    }, { status: 'pass', builds: 3, judged: 2 });
    for (const { form, judge: prompts, reviewer, events } of runs) {
      expect(judgeInput(prompts[1]!), form).toMatchObject({
        round: 2,
        cap: 2,
        rounds: [{ round: 1 }],
        skipped: [{ round: 1, finding: { evidence: TASTE.evidence } }],
      });
      expect(judgeInput(prompts[1]!), form).not.toHaveProperty('lastRound');
      // The stage's own reviewers read, on the third build, what the judge skipped.
      expect(reviewer[2], form).toContain(TASTE.evidence);
      const judged = events.filter((e): e is Extract<LoopEvent, { kind: 'refine:judge' }> => e.kind === 'refine:judge');
      expect(judged.map((e) => ({ target: e.target, round: e.round })), form).toEqual([{ target: 'write', round: 1 }, { target: 'write', round: 2 }]);
    }
  });

  it('the judge runs inside the time limit of the node that holds the review', async () => {
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[REVISE]],
      refine: { replies: [{ stop_reason: { choice: 'holds' } }] },
      timeoutMs: 54_321,
    }, { status: 'pass', builds: 1, judged: 1 });
    for (const { form, judgeTimeouts } of runs) expect(judgeTimeouts, form).toEqual([54_321]);
  });
});

describe('what one run keeps to itself', () => {
  it('a second run of the same workflow starts the judge with no rounds and no skipped findings', async () => {
    const built = build('workflow', {
      reviews: [[{ status: 'revise', summary: 'two findings', findings: [REAL, TASTE] }]],
      refine: { cap: 1, replies: [perFinding()] },
    });
    for (let i = 0; i < 2; i += 1) {
      const result = await run(built.job, { cwd: workDir() });
      expect(result.outcome.status).toBe('fail');
    }
    expect(built.judge).toHaveLength(4);
    expect(judgeInput(built.judge[1]!)).toMatchObject({ round: 2, rounds: [{ round: 1 }], skipped: [{ finding: { evidence: TASTE.evidence } }] });
    const second = judgeInput(built.judge[2]!);
    expect(second).toMatchObject({ round: 1, rounds: [] });
    expect(second).not.toHaveProperty('skipped');
  });

  it('what the judge skipped reaches every node that sends work back to the target', async () => {
    const seen: Record<string, unknown[]> = { a: [], b: [] };
    let builds = 0;
    const result = await run(dag({
      name: 'page',
      maxKickbacks: { write: judge(seat(new MockEngine((req) => JSON.stringify(perFinding()(req.prompt))), 'judge-mock')) },
      nodes: {
        write: fnJob('write', () => { builds += 1; return `draft ${builds}`; }),
        a: {
          needs: 'write',
          acceptsKickbackTo: ['write'],
          job: fnJob('a', (ctx) => {
            seen.a!.push(ctx.skippedFindings);
            return builds === 1 ? revisionRequest({ target: 'write', reason: 'two findings', findings: [REAL, TASTE] }) : 'clean';
          }),
        },
        b: {
          needs: 'write',
          acceptsKickbackTo: ['write'],
          job: fnJob('b', (ctx) => { seen.b!.push(ctx.skippedFindings); return 'clean'; }),
        },
      },
    }), { cwd: workDir() });
    expect(result.outcome.status).toBe('pass');
    expect(builds).toBe(2);
    const skipped = [{ round: 1, finding: TASTE, reason: 'a matter of taste' }];
    expect(seen.a).toEqual([undefined, skipped]);
    expect(seen.b).toEqual([undefined, skipped]);
  });

  it('two reviewers of the same build are one round: a request the judge lets stand does not use up the cap', async () => {
    const judged: string[] = [];
    let builds = 0;
    const result = await run(dag({
      name: 'page',
      maxKickbacks: { write: judge(seat(scripted([{ stop_reason: { choice: 'holds' } }, { stop_reason: { choice: 'continue' } }], judged), 'judge-mock'), { cap: 1 }) },
      nodes: {
        write: fnJob('write', () => { builds += 1; return `draft ${builds}`; }),
        style: {
          needs: 'write',
          acceptsKickbackTo: ['write'],
          job: fnJob('style', () => (builds === 1 ? revisionRequest({ target: 'write', reason: 'tone', findings: [TASTE] }) : 'clean')),
        },
        facts: {
          needs: 'style',
          acceptsKickbackTo: ['write'],
          job: fnJob('facts', () => (builds === 1 ? revisionRequest({ target: 'write', reason: 'audience', findings: [REAL] }) : 'clean')),
        },
      },
    }), { cwd: workDir() });
    expect(judged).toHaveLength(2);
    expect(judgeInput(judged[1]!)).toMatchObject({ round: 1, cap: 1 });
    expect(judgeInput(judged[1]!)).not.toHaveProperty('lastRound');
    expect(builds).toBe(2);
    expect(result.outcome.status).toBe('pass');
  });

  it('a send-back\'s feedback is read once: a later re-run of the node does not read it again', async () => {
    const feedback: (string | undefined)[] = [];
    let checks = 0;
    let finals = 0;
    const result = await run(dag({
      name: 'page',
      maxKickbacks: { plan: 1, write: 1 },
      nodes: {
        plan: fnJob('plan', () => 'planned'),
        write: { needs: 'plan', job: fnJob('write', (ctx) => { feedback.push(ctx.lastReview?.summary); return 'wrote'; }) },
        check: {
          needs: 'write',
          acceptsKickbackTo: ['write'],
          job: fnJob('check', () => (checks++ === 0 ? kickback('write', 'fix the title') : 'checked')),
        },
        final: {
          needs: 'check',
          acceptsKickbackTo: ['plan'],
          job: fnJob('final', () => (finals++ === 0 ? kickback('plan', 'plan for new users') : 'done')),
        },
      },
    }), { cwd: workDir() });
    expect(result.outcome.status).toBe('pass');
    expect(feedback).toHaveLength(3);
    expect(feedback[1]).toContain('fix the title');
    // The third run comes from the send-back to plan, not to write.
    expect(feedback[2]).toBeUndefined();
  });

  it('a send-back goes ahead when a passed nested graph holds an optional node that failed', async () => {
    let writes = 0;
    let checks = 0;
    const result = await run(dag({
      name: 'page',
      maxKickbacks: { write: 1 },
      nodes: {
        write: fnJob('write', () => `wrote ${++writes}`),
        lint: dag({
          name: 'lint',
          nodes: {
            spelling: { job: fnJob('spelling', () => { throw new Error('the spell checker is not installed'); }), optional: true },
            links: fnJob('links', () => 'links checked'),
          },
        }),
        check: {
          needs: ['write', 'lint'],
          acceptsKickbackTo: ['write'],
          job: fnJob('check', () => (checks++ === 0 ? kickback('write', 'fix the title') : 'checked')),
        },
      },
    }), { cwd: workDir() });
    expect(result.outcome.status).toBe('pass');
    expect(writes).toBe(2);
  });
});

describe.each(['workflow', 'dag'] as const)('a person reviewer with a judge across a resume (%s)', (form) => {
  /** A person who answers only through the callback store, so each review pauses the run. */
  async function waitingForPerson(cap?: number, refinements?: number) {
    const cwd = workDir();
    const store = await createStoredRunFixture('one-round-rule');
    stores.push(store);
    const callbacks = await createStoredCallbackClient(store.storage, store.runId);
    const writer: string[] = [];
    const judgeCalls: string[] = [];
    const writerEngine = new MockEngine((req: AgentRequest) => {
      writer.push(req.prompt);
      writeFileSync(join(req.cwd!, 'page.md'), `draft ${writer.length}`);
      return JSON.stringify({ status: 'pass', summary: `wrote draft ${writer.length}` });
    });
    const judgeEngine = scripted([{ stop_reason: { choice: 'continue' } }], judgeCalls);
    const refine = refinements ?? judge(seat(judgeEngine, 'judge-mock'), cap === undefined ? {} : { cap });
    // A resume builds the job again, as a fresh worker would.
    const job = (): Job => form === 'dag' ? dag({
      name: 'page',
      maxKickbacks: { write: refine },
      nodes: {
        write: agentJob({
          label: 'write',
          engine: writerEngine,
          model: 'writer-mock',
          workspaceMode: 'write',
          consumeFeedback: true,
          prompt: 'Write page.md.',
          outcome: (text) => outcomeFromAgentText(text),
        }),
        review: { needs: 'write', acceptsKickbackTo: ['write'], job: approval('review', { question: 'Is the page ready?', target: 'write' }) },
      },
    }) : workflow('page', {
      brief: BRIEF,
      roles: {
        writer: seat(writerEngine, 'writer-mock', ['Write']),
        reviewer: person('Is the page ready?', { interaction: { id: 'page-review', responseSchema: { type: 'object' } } }),
      },
      stages: [stage('write', { agent: 'writer', writes: 'page.md', reviewedBy: 'reviewer', refine })],
    });
    const recordTo = join(cwd, 'record.jsonl');
    const start = async () => (await run(job(), { cwd, recordTo, callbacks })).outcome;
    const resume = async () => (await run(job(), { cwd, recordTo, callbacks, resume: true })).outcome;
    return { callbacks, writer, judge: judgeCalls, start, resume };
  }

  type Refusal = InteractionResponse | { approved: boolean; note: string };
  async function answer(callbacks: StoredCallbackClient, response: Refusal) {
    const [question] = await callbacks.listPending();
    const claim = await callbacks.claim(question!.requestId, 'person');
    if (!claim.ok) throw new Error('could not claim the question');
    expect(await callbacks.submit(question!.requestId, claim.claimToken, 'person', question!.digest, response)).toMatchObject({ ok: true });
  }

  const refuse = (note: string): Refusal => form === 'dag'
    ? { approved: false, note }
    : { feedback: {}, decision: 'changes-requested', prompt: note };

  it('waits for the person before the judge, and the judge reads the answer that arrives on a resume', async () => {
    const page = await waitingForPerson();
    expect((await page.start()).status).toBe('paused');
    expect(page.judge).toHaveLength(0);
    await answer(page.callbacks, refuse('Say who the page is for.'));
    expect((await page.resume()).status).toBe('paused');
    expect(page.judge).toHaveLength(1);
    expect(judgeInput(page.judge[0]!)).toMatchObject({ round: 1, latestFindings: [{ severity: 'block', evidence: 'Say who the page is for.' }] });
    expect(page.writer).toHaveLength(2);
    expect(page.writer[1]).toContain('Say who the page is for.');
  });

  it('keeps the judge\'s earlier rounds when the run pauses for the person\'s next review', async () => {
    const page = await waitingForPerson();
    await page.start();
    await answer(page.callbacks, refuse('Say who the page is for.'));
    await page.resume();
    await answer(page.callbacks, refuse('Name the reader in the title.'));
    expect((await page.resume()).status).toBe('paused');
    expect(page.judge).toHaveLength(2);
    expect(judgeInput(page.judge[1]!)).toMatchObject({
      round: 2,
      latestFindings: [{ evidence: 'Name the reader in the title.' }],
      rounds: [{ round: 1, findings: [{ evidence: 'Say who the page is for.' }] }],
    });
  });

  it('stops at the cap when the refusals arrive on resumes', async () => {
    const page = await waitingForPerson(1);
    await page.start();
    await answer(page.callbacks, refuse('Say who the page is for.'));
    await page.resume();
    await answer(page.callbacks, refuse('Name the reader in the title.'));
    expect((await page.resume()).status).toBe('fail');
    expect(page.writer).toHaveLength(2);
    expect(page.judge).toHaveLength(2);
    expect(judgeInput(page.judge[1]!)).toMatchObject({ round: 2, cap: 1, lastRound: true });
  });

  it('with no judge, stops after the refinements when the refusals arrive on resumes', async () => {
    const page = await waitingForPerson(undefined, 2);
    await page.start();
    await answer(page.callbacks, refuse('Say who the page is for.'));
    expect((await page.resume()).status).toBe('paused');
    await answer(page.callbacks, refuse('Name the reader in the title.'));
    expect((await page.resume()).status).toBe('paused');
    await answer(page.callbacks, refuse('Shorten the first line.'));
    expect((await page.resume()).status).toBe('fail');
    expect(page.writer).toHaveLength(3);
    expect(page.writer[2]).toContain('Name the reader in the title.');
  });
});

/**
 * A run stopped between two rounds resumes at the next round, with the
 * feedback that asked for it, and the refinements already used stay used.
 * A reviewed stage pauses on a usage limit; a plain dag fails on one, so the
 * paired runs stop with an abort.
 */
describe.each([
  ['workflow', 'a usage limit'],
  ['workflow', 'an abort'],
  ['dag', 'an abort'],
] as const)('a run stopped between rounds keeps the refinements used (%s, %s)', (form, stop) => {
  const UNMET = { requirements: [{ requirement: 'Says who it is for', verdict: 'unmet', evidence: 'no audience named' }] };
  const REFUSE = { status: 'revise', summary: 'one finding', findings: [{ severity: 'should-fix', evidence: 'the title is vague' }] };
  const cases = [
    { name: 'an unmet requirement', refine: 1, goal: [UNMET], reviews: [PASS], feedback: 'no audience named' },
    { name: 'a numeric review', refine: 1, reviews: [REFUSE], feedback: 'the title is vague' },
    { name: 'an unmet requirement under a judge', refine: { cap: 1 }, goal: [UNMET], reviews: [PASS], feedback: 'no audience named' },
  ] as const;

  it.each(cases)('$name: the resume builds the next round with its feedback, and no refinement comes back', async (intent) => {
    const cwd = workDir();
    const writer: string[] = [];
    const judgeCalls: string[] = [];
    const controller = new AbortController();
    // The second build stops the run once; every other build writes a draft.
    const writerEngine = new MockEngine((req: AgentRequest) => {
      writer.push(req.prompt);
      if (writer.length === 2) {
        if (stop === 'a usage limit') throw new LoopError({ code: 'QUOTA', message: 'usage limit' });
        controller.abort();
        throw new Error('stopped');
      }
      writeFileSync(join(req.cwd!, 'page.md'), `draft ${writer.length}`);
      return JSON.stringify({ status: 'pass', summary: `wrote draft ${writer.length}` });
    });
    const reviewEngine = scripted(intent.reviews, []);
    const goalSeat = 'goal' in intent ? seat(scripted(intent.goal, []), 'goal-mock', ['Read']) : undefined;
    const judgeEngine = scripted([{ stop_reason: { choice: 'continue' } }], judgeCalls);
    const refine = typeof intent.refine === 'number' ? intent.refine : judge(seat(judgeEngine, 'judge-mock'), intent.refine);
    // A resume builds the job again, as a fresh worker would.
    const job = (): Job => form === 'workflow' ? workflow('page', {
      brief: BRIEF,
      roles: { writer: seat(writerEngine, 'writer-mock', ['Write']), reviewer: [seat(reviewEngine, 'reviewer-1', ['Read'])] },
      stages: [stage('write', { agent: 'writer', writes: 'page.md', reviewedBy: 'reviewer', refine, ...(goalSeat ? { goal: goalSeat } : {}) })],
    }) : dag({
      name: 'page',
      maxKickbacks: { write: refine },
      nodes: {
        write: agentJob({
          label: 'write',
          engine: writerEngine,
          model: 'writer-mock',
          workspaceMode: 'write',
          consumeFeedback: true,
          prompt: 'Write page.md.',
          outcome: (text) => outcomeFromAgentText(text),
        }),
        ...(goalSeat ? { goal: { needs: 'write', job: goalCheck(goalSeat, { target: 'write', text: BRIEF }), acceptsKickbackTo: ['write'] } } : {}),
        review: {
          needs: goalSeat ? 'goal' : 'write',
          acceptsKickbackTo: ['write'],
          job: reviewPanel({
            label: 'write',
            target: 'write',
            reviewers: [{
              name: 'write-1',
              job: agentJob({
                label: 'write-1', engine: reviewEngine, model: 'reviewer-1', workspaceMode: 'read', tools: ['Read'],
                prompt: 'Review page.md.', outcome: (text) => outcomeFromAgentText(text),
              }),
            }],
          }),
        },
      },
    });
    const recordTo = join(cwd, 'record.jsonl');
    const first = await run(job(), { cwd, recordTo, signal: controller.signal });
    expect(first.outcome.status).toBe(stop === 'a usage limit' ? 'paused' : 'aborted');
    expect(writer).toHaveLength(2);
    const resumed = await run(job(), { cwd, recordTo, resume: true });
    // The refinement was used before the stop: the resumed build is the
    // last one, and it reads the feedback that asked for it.
    expect(resumed.outcome.status).toBe('fail');
    expect(writer).toHaveLength(3);
    expect(writer[2]).toContain(intent.feedback);
    expect(judgeCalls).toHaveLength(0);
  });
});

describe('a resume that reuses the saved rounds', () => {
  it('keeps the recorded model of every reused step, so a later panel still refuses a writer from its own family', async () => {
    const cwd = workDir();
    const store = await createStoredRunFixture('one-round-rule');
    stores.push(store);
    const callbacks = await createStoredCallbackClient(store.storage, store.runId);
    let builds = 0;
    // The writer is declared as one family, but answers with a model from the reviewers' family.
    const writerEngine = new MockEngine((req: AgentRequest) => {
      builds += 1;
      writeFileSync(join(req.cwd!, 'page.md'), `draft ${builds}`);
      return { text: JSON.stringify({ status: 'pass', summary: `wrote draft ${builds}` }), model: 'claude-sonnet-4-5' };
    });
    const reviewer: string[] = [];
    const reviewerEngine = new MockEngine((req: AgentRequest) => {
      reviewer.push(req.prompt);
      return { text: JSON.stringify(PASS), model: 'claude-sonnet-4-5' };
    });
    let checks = 0;
    // A resume builds the job again, as a fresh worker would.
    const job = (): Job => workflow('page', {
      brief: BRIEF,
      roles: {
        writer: { engine: writerEngine, identity: { adapter: 'mock', provider: 'mock', modelFamily: 'gpt', model: 'gpt-5', tools: ['Write'] } },
        approver: person('Is the page ready?'),
        reviewer: [{ engine: reviewerEngine, identity: { adapter: 'mock', provider: 'mock', modelFamily: 'claude', model: 'claude-sonnet-4-5', tools: ['Read'] } }],
      },
      stages: [
        stage('write', { agent: 'writer', writes: 'page.md' }),
        // One send-back, so the graph saves its rounds with the steps that passed.
        stage('check', { sendsBackTo: 'write', fn: fnJob('check', () => (++checks === 1 ? kickback('write', 'name the reader') : 'checked')) }),
        stage('approve', { input: 'approver' }),
        stage('review', { panel: 'reviewer', agree: 1 }),
      ],
    });
    const recordTo = join(cwd, 'record.jsonl');
    expect((await run(job(), { cwd, recordTo, callbacks })).outcome.status).toBe('paused');
    expect(builds).toBe(2);
    const [question] = await callbacks.listPending();
    const claim = await callbacks.claim(question!.requestId, 'person');
    if (!claim.ok) throw new Error('could not claim the question');
    expect(await callbacks.submit(question!.requestId, claim.claimToken, 'person', question!.digest, { approved: true })).toMatchObject({ ok: true });

    const resumed = await run(job(), { cwd, recordTo, callbacks, resume: true });
    // The writer and the check came from the saved rounds, not a new build.
    expect(builds).toBe(2);
    expect(resumed.outcome.status).toBe('fail');
    expect(JSON.stringify(resumed.outcome)).toMatch(/recorded model family collision/);
    expect(reviewer).toHaveLength(0);
  });
});

describe('the check for unchanged work in a git workspace', () => {
  it('a writer that only stages and commits the reviewed work has not changed it', async () => {
    const cwd = await tmpRepo();
    let builds = 0;
    const writerEngine = new MockEngine((req: AgentRequest) => {
      builds += 1;
      if (builds === 1) writeFileSync(join(req.cwd!, 'page.md'), 'draft');
      else {
        execFileSync('git', ['add', 'page.md'], { cwd: req.cwd! });
        execFileSync('git', ['commit', '-m', 'docs: add the page'], { cwd: req.cwd! });
      }
      return JSON.stringify({ status: 'pass', summary: `build ${builds}` });
    });
    const result = await run(dag({
      name: 'page',
      maxKickbacks: { write: 2 },
      nodes: {
        write: agentJob({ label: 'write', engine: writerEngine, model: 'writer-mock', workspaceMode: 'write', consumeFeedback: true, prompt: 'Write page.md.', outcome: (text) => outcomeFromAgentText(text) }),
        review: {
          needs: 'write',
          acceptsKickbackTo: ['write'],
          job: fnJob('review', () => (builds === 1 ? revisionRequest({ target: 'write', reason: 'one finding', findings: [FINDING] }) : 'clean')),
        },
      },
    }), { cwd });
    expect(builds).toBe(2);
    expect(result.outcome.status).toBe('fail');
    expect(result.outcome.summary).toContain('write returned the reviewed work unchanged after feedback');
  });

  it.each(['workflow', 'dag', 'loop'] as const)('a writer that leaves its declared file as it was has not changed the work, whatever else it writes (%s)', async (form) => {
    const cwd = await tmpRepo();
    const built = build(form, { reviews: [[REVISE]], refine: 3, unchanged: true, scratch: true });
    const result = await run(built.job, { cwd });
    expect(built.writer).toHaveLength(2);
    expect(result.outcome.status).toBe('fail');
    expect(result.outcome.summary).toContain('write returned the reviewed work unchanged after feedback');
  });

  it.each([
    { name: 'a writer in a loop inside a node checks the node\'s declared file', inner: (writer: Job) => loop({ name: 'attempt', max: 1, body: writer }), status: 'fail' },
    { name: 'a writer in a nested node with no file checks the whole workspace, not an outer node\'s file', inner: (writer: Job) => dag({ name: 'inner', nodes: { draft: { job: writer } } }), status: 'pass' },
  ])('$name', async ({ inner, status }) => {
    const cwd = await tmpRepo();
    let builds = 0;
    const writerEngine = new MockEngine((req: AgentRequest) => {
      builds += 1;
      writeFileSync(join(req.cwd!, 'page.md'), 'draft');
      writeFileSync(join(req.cwd!, 'scratch.md'), `notes ${builds}`);
      return JSON.stringify({ status: 'pass', summary: `build ${builds}` });
    });
    const writer = agentJob({ label: 'write', engine: writerEngine, model: 'writer-mock', workspaceMode: 'write', consumeFeedback: true, prompt: 'Write page.md.', outcome: (text) => outcomeFromAgentText(text) });
    const result = await run(dag({
      name: 'page',
      maxKickbacks: { write: 3 },
      nodes: {
        write: { job: inner(writer), file: 'page.md' },
        review: {
          needs: 'write',
          acceptsKickbackTo: ['write'],
          job: fnJob('review', () => (builds === 1 ? revisionRequest({ target: 'write', reason: 'one finding', findings: [FINDING] }) : 'clean')),
        },
      },
    }), { cwd });
    expect(builds).toBe(2);
    expect(result.outcome.status).toBe(status);
    if (status === 'fail') expect(JSON.stringify(result.outcome)).toContain('write returned the reviewed work unchanged after feedback');
  });

  it.each([
    ...(['workflow', 'dag', 'loop'] as const).map((form) => ({ form, refine: 3 as Intent['refine'], judged: 0 })),
    ...(['workflow', 'dag'] as const).map((form) => ({ form, refine: { replies: [{ stop_reason: { choice: 'continue' } }] } as Intent['refine'], judged: 3 })),
  ])('a writer that fixes a declared file Git ignores has changed the work, every round ($form, judged $judged)', async ({ form, refine, judged }) => {
    const cwd = await tmpRepo();
    writeFileSync(join(cwd, '.gitignore'), 'page.md\n');
    execFileSync('git', ['add', '.gitignore'], { cwd });
    execFileSync('git', ['commit', '-m', 'chore: ignore the page'], { cwd });
    const built = build(form, { reviews: [[REVISE, REVISE, REVISE, PASS]], refine });
    const result = await run(built.job, { cwd });
    expect(built.writer).toHaveLength(4);
    expect(built.judge).toHaveLength(judged);
    expect(result.outcome.status).toBe('pass');
  });
});

describe('send-back targets in workflow()', () => {
  it('declares a stage\'s sendsBackTo on its node, so a send-back anywhere else is an error that names both', async () => {
    const result = await run(workflow('page', {
      brief: BRIEF,
      roles: {},
      stages: [
        stage('plan', { fn: fnJob('plan', () => 'planned') }),
        stage('write', { fn: fnJob('write', () => 'wrote') }),
        stage('check', { sendsBackTo: 'write', fn: fnJob('check', () => kickback('plan', 'plan again')) }),
      ],
    }), { cwd: workDir() });
    expect(result.outcome.status).toBe('fail');
    expect((result.outcome.data as Record<string, Outcome>).check).toMatchObject({
      status: 'fail',
      summary: 'dag "page": node "check" sent work back to "plan", which it does not declare in acceptsKickbackTo',
    });
  });

  it('takes agree only on a stage a panel reviews', () => {
    expect(() => workflow('page', {
      brief: BRIEF,
      roles: { writer: seat(new MockEngine(() => '{}'), 'writer-mock', ['Write']), reviewer: person('Ready?', { interaction: { id: 'r', responseSchema: {} } }) },
      stages: [stage('write', { agent: 'writer', writes: 'page.md', reviewedBy: 'reviewer', agree: 1 })],
    })).toThrow('agree is for a stage reviewed by a panel or a panel stage: write');
  });
});
