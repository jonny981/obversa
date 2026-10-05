/**
 * The same intent, written as a reviewed `workflow()` stage, as a `dag()`
 * (a writer node, a review node and `maxKickbacks`) and, where it applies, as
 * a `loop()` with a graph body, behaves the same: the same outcome, the same
 * number of builds, the same judge consultations and the same judge input.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { agentJob, approval, commandJob, createStoredCallbackClient, dag, exitCodeFor, fnJob, goalCheck, judge, kickback, loop, LoopError, person, reviewPanel, revisionRequest, run, stage, workflow } from '../src/api.ts';
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
  /** The writing step's task and the bar it must meet. */
  readonly desc?: string;
  readonly gate?: string;
  /** A command run after the review, that sends the work back when it fails. */
  readonly check?: readonly string[];
  /** A second command, run after `check`, that sends the work back when it fails. */
  readonly secondCheck?: readonly string[];
  /** A command run before the writer. */
  readonly lint?: readonly string[];
  /** What the writer changes besides the page, on each build. */
  readonly edit?: (dir: string, build: number) => void;
  /** Make the workspace a git repository before the run. */
  readonly repo?: (dir: string) => Promise<void>;
  /** The run works in this folder of the repository, not at its top. */
  readonly folder?: string;
  /** The run's `judgeContextLimit`. */
  readonly judgeContextLimit?: number;
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
    intent.edit?.(req.cwd!, calls.writer.length);
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
        stages: [...(intent.lint ? [stage('lint', { run: intent.lint })] : []), stage('write', {
          agent: 'writer',
          writes: 'page.md',
          reviewedBy: 'reviewer',
          refine,
          ...(intent.agree !== undefined ? { agree: intent.agree } : {}),
          ...(goalSeat ? { goal: goalSeat } : {}),
          ...(intent.desc !== undefined ? { desc: intent.desc } : {}),
          ...(intent.gate !== undefined ? { gate: intent.gate } : {}),
        }), ...(intent.approve ? [stage('approve', { fn: approve, sendsBackTo: 'write' })] : []),
        ...(intent.check ? [stage('check', { run: intent.check, sendsBackTo: 'write' })] : []),
        ...(intent.secondCheck ? [stage('second-check', { run: intent.secondCheck, sendsBackTo: 'write' })] : [])],
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
      brief: BRIEF,
      useCase: 'a reader gets a clear, short page.',
      maxKickbacks: { write: refine },
      nodes: {
        ...(intent.lint ? { lint: commandJob('lint', intent.lint) } : {}),
        write: {
          job: writer,
          file: 'page.md',
          ...(intent.lint ? { needs: 'lint' } : {}),
          ...(intent.desc !== undefined ? { desc: intent.desc } : {}),
          ...(intent.gate !== undefined ? { gate: intent.gate } : {}),
        },
        ...(goalSeat ? { goal: { needs: 'write', job: goalCheck(goalSeat, { target: 'write', text: BRIEF }), acceptsKickbackTo: ['write'] } } : {}),
        review: {
          needs: goalSeat ? 'goal' : 'write',
          job: review,
          acceptsKickbackTo: ['write'],
          ...(intent.timeoutMs !== undefined ? { timeoutMs: intent.timeoutMs } : {}),
        },
        ...(intent.approve ? { approve: { needs: 'review', job: approve, acceptsKickbackTo: ['write'] } } : {}),
        ...(intent.check ? { check: { needs: intent.approve ? 'approve' : 'review', job: commandJob('check', intent.check, { target: 'write' }), acceptsKickbackTo: ['write'] } } : {}),
        ...(intent.secondCheck ? { 'second-check': { needs: 'check', job: commandJob('second-check', intent.secondCheck, { target: 'write' }), acceptsKickbackTo: ['write'] } } : {}),
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

/** Everything the judge reads, in its four labelled parts, and what the size limit cut. */
type Packet = Record<'why' | 'what' | 'how' | 'when', Record<string, unknown>> & { cut?: string[] };
function judgeInput(prompt: string): Packet {
  return (JSON.parse(prompt) as { state: Packet }).state;
}

async function runForm(form: Form, intent: Intent) {
  const built = build(form, intent);
  const events: LoopEvent[] = [];
  const top = workDir();
  await intent.repo?.(top);
  const cwd = intent.folder === undefined ? top : join(top, intent.folder);
  const result = await run(built.job, {
    cwd,
    onEvent: (event) => events.push(event),
    ...(intent.judgeContextLimit !== undefined ? { judgeContextLimit: intent.judgeContextLimit } : {}),
  });
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
      expect(judgeInput(prompts[0]!), form).toMatchObject({ when: { round: 1, rounds: [], limit: expect.stringContaining('No round limit') } });
      // The judge reads what the work is for and the file it reviews.
      expect(judgeInput(prompts[0]!), form).toMatchObject({ why: { useCase: 'a reader gets a clear, short page.' }, what: { file: 'page.md', draft: 'draft 1' } });
      expect(judgeInput(prompts[1]!), form).toMatchObject({ what: { draft: 'draft 2' }, when: { rounds: [{ round: 1, changedLines: 1 }] } });
      expect(judgeInput(prompts[1]!), form).toMatchObject({ when: { round: 2, rounds: [{ round: 1 }] } });
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
      expect(judgeInput(prompts[0]!).when, form).not.toHaveProperty('lastRound');
      expect(judgeInput(prompts[1]!), form).toMatchObject({ when: { round: 2, cap: 1, lastRound: true } });
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
      expect(judgeInput(prompts[0]!), form).toMatchObject({ when: { round: 2, cap: 2, rounds: [] } });
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
      expect(judgeInput(prompts[1]!), form).toMatchObject({ why: { productFeedback: [{ prompt: 'Write for new users.' }] }, when: { round: 2 } });
    }
  });

  it('a person reviewer with a judge consults the judge on each refusal', async () => {
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [],
      person: ['Say who the page is for.', null],
      refine: { replies: [{ stop_reason: { choice: 'continue' } }] },
    }, { status: 'pass', builds: 2, judged: 1 });
    for (const { form, judge: prompts, writer } of runs) {
      expect(judgeInput(prompts[0]!), form).toMatchObject({ how: { findings: [{ severity: 'block', evidence: 'Say who the page is for.' }] }, when: { round: 1 } });
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
      expect(judgeInput(prompts[1]!), form).toMatchObject({ when: {
        round: 2,
        cap: 2,
        rounds: [{ round: 1 }],
        skipped: [{ round: 1, finding: { evidence: TASTE.evidence } }],
      } });
      expect(judgeInput(prompts[1]!).when, form).not.toHaveProperty('lastRound');
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

/** A git repository holding a committed sixty-line `notes.md`, in `folder` when one is given. */
async function notesRepo(dir: string, folder = '.'): Promise<void> {
  const lines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
  mkdirSync(join(dir, folder), { recursive: true });
  writeFileSync(join(dir, folder, 'notes.md'), `${lines.join('\n')}\n`);
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Test'], ['config', 'commit.gpgsign', 'false'], ['add', '-A'], ['commit', '-q', '-m', 'notes']]) {
    execFileSync('git', args, { cwd: dir });
  }
}

/** Change lines of `notes.md` by number. */
function editNotes(dir: string, changes: Readonly<Record<number, string>>): void {
  const lines = Array.from({ length: 60 }, (_, index) => changes[index + 1] ?? `line ${index + 1}`);
  writeFileSync(join(dir, 'notes.md'), `${lines.join('\n')}\n`);
}

describe('what the judge reads, the same in every form', () => {
  it('the why: the brief, what the work is for, and the target\'s desc and gate', async () => {
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[REVISE]],
      desc: 'Write the welcome page.',
      gate: 'A new reader knows who the page is for.',
      refine: { replies: [{ stop_reason: { choice: 'holds' } }] },
    }, { status: 'pass', builds: 1, judged: 1 });
    for (const { form, judge: prompts } of runs) {
      expect(judgeInput(prompts[0]!).why, form).toEqual({
        brief: BRIEF,
        useCase: 'a reader gets a clear, short page.',
        desc: 'Write the welcome page.',
        gate: 'A new reader knows who the page is for.',
      });
    }
  });

  it('the what: the files changed since the work began, and the diff around the line a finding cites', async () => {
    const cites = { status: 'revise', summary: 'one finding', findings: [{ severity: 'should-fix', evidence: 'notes.md:50 still says the old thing' }] };
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[cites]],
      repo: notesRepo,
      edit: (dir, build) => editNotes(dir, build === 1 ? { 5: 'line 5 changed', 50: 'line 50 changed' } : { 5: 'line 5 changed', 50: 'line 50 fixed' }),
      refine: { replies: [{ stop_reason: { choice: 'continue' } }, { stop_reason: { choice: 'holds' } }] },
    }, { status: 'pass', builds: 2, judged: 2 });
    for (const { form, judge: prompts } of runs) {
      const first = judgeInput(prompts[0]!);
      expect(first.what.changedFiles, form).toEqual([
        { path: 'notes.md', added: 2, removed: 2 },
        { path: 'page.md', added: 1, removed: 0 },
      ]);
      // Only the hunk around line 50: the change at line 5 is too far away.
      const diffs = first.what.diffs as { file: string; line: number; diff: string }[];
      expect(diffs.map(({ file, line }) => ({ file, line })), form).toEqual([{ file: 'notes.md', line: 50 }]);
      expect(diffs[0]!.diff, form).toContain('+line 50 changed');
      expect(diffs[0]!.diff, form).not.toContain('line 5 changed');
      // The second round says what changed since the first.
      expect(judgeInput(prompts[1]!).when.changedSinceLastRound, form).toEqual([
        { path: 'notes.md', added: 1, removed: 1 },
        { path: 'page.md', added: 1, removed: 1 },
      ]);
    }
  });

  it('the what: a finding that cites a line of a deleted file reads the diff that removed it', async () => {
    const cites = { status: 'revise', summary: 'one finding', findings: [{ severity: 'should-fix', evidence: 'notes.md:50 held the only copy of the old rule' }] };
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[cites]],
      repo: notesRepo,
      edit: (dir) => rmSync(join(dir, 'notes.md'), { force: true }),
      refine: { replies: [{ stop_reason: { choice: 'holds' } }] },
    }, { status: 'pass', builds: 1, judged: 1 });
    for (const { form, judge: prompts } of runs) {
      const { what } = judgeInput(prompts[0]!);
      expect(what.changedFiles, form).toContainEqual({ path: 'notes.md', added: 0, removed: 60 });
      const diffs = what.diffs as { file: string; line: number; diff: string }[] | undefined;
      expect(diffs?.map(({ file, line }) => ({ file, line })), form).toEqual([{ file: 'notes.md', line: 50 }]);
      expect(diffs![0]!.diff, form).toContain('-line 50');
    }
  });

  it('the what: a run in a folder of the repository reads the diff around the cited line', async () => {
    const cites = { status: 'revise', summary: 'one finding', findings: [{ severity: 'should-fix', evidence: 'notes.md:50 still says the old thing' }] };
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[cites]],
      repo: (dir) => notesRepo(dir, 'docs'),
      folder: 'docs',
      edit: (dir) => editNotes(dir, { 50: 'line 50 changed' }),
      refine: { replies: [{ stop_reason: { choice: 'holds' } }] },
    }, { status: 'pass', builds: 1, judged: 1 });
    for (const { form, judge: prompts } of runs) {
      const { what } = judgeInput(prompts[0]!);
      expect(what.changedFiles, form).toEqual([
        { path: 'docs/notes.md', added: 1, removed: 1 },
        { path: 'docs/page.md', added: 1, removed: 0 },
      ]);
      const diffs = what.diffs as { file: string; line: number; diff: string }[] | undefined;
      expect(diffs?.map(({ file, line }) => ({ file, line })), form).toEqual([{ file: 'docs/notes.md', line: 50 }]);
      expect(diffs![0]!.diff, form).toContain('+line 50 changed');
    }
  });

  it('the what: a finding that cites a file with no extension, a dot file or a folder in brackets reads that file\'s diff', async () => {
    const cites = {
      status: 'revise',
      summary: 'four findings',
      findings: [
        { severity: 'should-fix', evidence: 'Dockerfile:2 pins an old base image' },
        { severity: 'should-fix', evidence: 'Makefile:2 skips the tests' },
        { severity: 'should-fix', evidence: '.gitignore:2 hides the build output' },
        { severity: 'should-fix', evidence: 'app/[id]/page.tsx:2 reads the wrong id' },
      ],
    };
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[cites]],
      repo: async (dir) => {
        // `api/page.tsx` comes first among the changed files, so a reader that
        // drops the bracketed folder picks it instead.
        mkdirSync(join(dir, 'app', '[id]'), { recursive: true });
        mkdirSync(join(dir, 'api'), { recursive: true });
        for (const file of ['Dockerfile', 'Makefile', '.gitignore', 'api/page.tsx', 'app/[id]/page.tsx']) writeFileSync(join(dir, file), 'one\ntwo\n');
        await notesRepo(dir);
      },
      edit: (dir) => {
        for (const file of ['Dockerfile', 'Makefile', '.gitignore', 'api/page.tsx', 'app/[id]/page.tsx']) writeFileSync(join(dir, file), `one\n${file} changed\n`);
      },
      refine: { replies: [{ stop_reason: { choice: 'holds' } }] },
    }, { status: 'pass', builds: 1, judged: 1 });
    for (const { form, judge: prompts } of runs) {
      const diffs = judgeInput(prompts[0]!).what.diffs as { file: string; line: number; diff: string }[] | undefined;
      expect(diffs?.map(({ file, line }) => ({ file, line })), form).toEqual([
        { file: 'Dockerfile', line: 2 },
        { file: 'Makefile', line: 2 },
        { file: '.gitignore', line: 2 },
        { file: 'app/[id]/page.tsx', line: 2 },
      ]);
      expect(diffs![3]!.diff, form).toContain('+app/[id]/page.tsx changed');
    }
  });

  it('the what: a finding that cites a changed path reads that file\'s diff, not a longer or shorter path that ends the same way', async () => {
    const cites = {
      status: 'revise',
      summary: 'two findings',
      findings: [
        { severity: 'should-fix', evidence: 'src/index.ts:2 exports the wrong name' },
        { severity: 'should-fix', evidence: 'docs/README.md:2 gives the wrong command' },
      ],
    };
    const files = ['README.md', 'docs/README.md', 'packages/app/src/index.ts', 'src/index.ts'];
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[cites]],
      repo: async (dir) => {
        // Git lists `README.md` before `docs/README.md` and `packages/app/src/index.ts`
        // before `src/index.ts`, so a reader that takes the first path ending
        // the same way picks the wrong file for both findings.
        for (const folder of ['docs', 'packages/app/src', 'src']) mkdirSync(join(dir, folder), { recursive: true });
        for (const file of files) writeFileSync(join(dir, file), 'one\ntwo\n');
        await notesRepo(dir);
      },
      edit: (dir) => {
        for (const file of files) writeFileSync(join(dir, file), `one\n${file} changed\n`);
      },
      refine: { replies: [{ stop_reason: { choice: 'holds' } }] },
    }, { status: 'pass', builds: 1, judged: 1 });
    for (const { form, judge: prompts } of runs) {
      const diffs = judgeInput(prompts[0]!).what.diffs as { file: string; line: number; diff: string }[] | undefined;
      expect(diffs?.map(({ file, line }) => ({ file, line })), form).toEqual([
        { file: 'src/index.ts', line: 2 },
        { file: 'docs/README.md', line: 2 },
      ]);
      expect(diffs![0]!.diff, form).toContain('+src/index.ts changed');
      expect(diffs![1]!.diff, form).toContain('+docs/README.md changed');
    }
  });

  it('the how: each check\'s command, its result and its failing lines', async () => {
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[PASS]],
      check: ['node', '-e', 'console.log("FAIL: expected 2, got 3");process.exit(1)'],
      refine: { replies: [{ stop_reason: { choice: 'holds' } }] },
    }, { status: 'pass', builds: 1, judged: 1 });
    for (const { form, judge: prompts } of runs) {
      const checks = judgeInput(prompts[0]!).how.checks as { name: string; command: string; status: string; output: string }[];
      expect(checks, form).toEqual([{
        name: 'check',
        command: 'node -e console.log("FAIL: expected 2, got 3");process.exit(1)',
        status: 'fail',
        output: expect.stringContaining('FAIL: expected 2, got 3'),
      }]);
    }
  });

  it('the how: a failed check the judge let stand still reads as failed when a later check fails', async () => {
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[PASS]],
      check: ['node', '-e', 'console.log("FAIL: first check");process.exit(1)'],
      secondCheck: ['node', '-e', 'console.log("FAIL: second check");process.exit(1)'],
      refine: { replies: [{ stop_reason: { choice: 'holds' } }] },
    }, { status: 'pass', builds: 1, judged: 2 });
    for (const { form, judge: prompts } of runs) {
      const checks = judgeInput(prompts[1]!).how.checks as { name: string; status: string; output?: string }[];
      expect(checks.map(({ name, status }) => ({ name, status })), form).toEqual([
        { name: 'check', status: 'fail' },
        { name: 'second-check', status: 'fail' },
      ]);
      expect(checks[0]!.output, form).toContain('FAIL: first check');
    }
  });

  it('the how: a check that ran before the writer reaches the judge of the writer\'s own review', async () => {
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[REVISE]],
      lint: ['node', '-e', 'process.exit(0)'],
      refine: { replies: [{ stop_reason: { choice: 'holds' } }] },
    }, { status: 'pass', builds: 1, judged: 1 });
    for (const { form, judge: prompts } of runs) {
      expect(judgeInput(prompts[0]!).how.checks, form).toEqual([{ name: 'lint', command: 'node -e process.exit(0)', status: 'pass' }]);
    }
  });

  it('the how: a check after a review that sends the work back has not run, so the judge of that review reads no result for it', async () => {
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[REVISE]],
      check: ['node', '-e', 'process.exit(0)'],
      refine: { replies: [{ stop_reason: { choice: 'holds' } }] },
    }, { status: 'pass', builds: 1, judged: 1 });
    for (const { form, judge: prompts } of runs) {
      expect(judgeInput(prompts[0]!).how.checks, form).toBeUndefined();
    }
  });

  it('the how: the goal check\'s verdicts', async () => {
    const met = { requirements: [{ requirement: 'Says who it is for', verdict: 'met', evidence: 'page.md:1 names new staff' }] };
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[REVISE]],
      goal: [met],
      refine: { replies: [{ stop_reason: { choice: 'holds' } }] },
    }, { status: 'pass', builds: 1, judged: 1 });
    for (const { form, judge: prompts } of runs) {
      expect(judgeInput(prompts[0]!).how.goal, form).toEqual(met.requirements);
    }
  });

  it('the how: with two targets, each judge reads only its own target\'s goal check', async () => {
    const intro = { requirements: [{ requirement: 'Greets the reader', verdict: 'met', evidence: 'intro.md:1 says hello' }] };
    const page = { requirements: [{ requirement: 'Says who it is for', verdict: 'met', evidence: 'page.md:1 names new staff' }] };
    const inputs: Partial<Record<'workflow' | 'dag', string[]>> = {};
    for (const form of ['workflow', 'dag'] as const) {
      const judged: string[] = [];
      inputs[form] = judged;
      const writes = (file: string) => new MockEngine((req: AgentRequest) => {
        writeFileSync(join(req.cwd!, file), `${file} draft`);
        return JSON.stringify({ status: 'pass', summary: `wrote ${file}` });
      });
      const reviewer = new MockEngine(() => JSON.stringify(REVISE));
      const goalSeat = (reply: unknown) => seat(scripted([reply], []), 'goal-mock', ['Read']);
      const judgeSeat = seat(scripted([{ stop_reason: { choice: 'holds' } }], judged), 'judge-mock');
      const job = form === 'workflow'
        ? workflow('pages', {
          brief: BRIEF,
          roles: {
            introWriter: seat(writes('intro.md'), 'writer-mock', ['Write']),
            pageWriter: seat(writes('page.md'), 'writer-mock', ['Write']),
            reviewer: [seat(reviewer, 'reviewer-1', ['Read'])],
          },
          stages: [
            stage('intro', { agent: 'introWriter', writes: 'intro.md', reviewedBy: 'reviewer', refine: judge(judgeSeat), goal: goalSeat(intro) }),
            stage('page', { agent: 'pageWriter', writes: 'page.md', reviewedBy: 'reviewer', refine: judge(judgeSeat), goal: goalSeat(page) }),
          ],
        })
        : (() => {
          const writer = (file: string) => agentJob({ label: file, engine: writes(file), model: 'writer-mock', workspaceMode: 'write', consumeFeedback: true, prompt: `Write ${file}.`, outcome: (text) => outcomeFromAgentText(text) });
          const panel = (target: string) => reviewPanel({
            label: target,
            target,
            reviewers: [{ name: `${target}-1`, job: agentJob({ label: `${target}-1`, engine: reviewer, model: 'reviewer-1', workspaceMode: 'read', tools: ['Read'], prompt: 'Review.', outcome: (text) => outcomeFromAgentText(text) }) }],
          });
          return dag({
            name: 'pages',
            brief: BRIEF,
            useCase: 'a reader gets a clear, short page.',
            maxKickbacks: { intro: judge(judgeSeat), page: judge(judgeSeat) },
            nodes: {
              intro: { job: writer('intro.md'), file: 'intro.md' },
              'intro-goal': { needs: 'intro', job: goalCheck(goalSeat(intro), { target: 'intro', text: BRIEF }), acceptsKickbackTo: ['intro'] },
              'intro-review': { needs: 'intro-goal', job: panel('intro'), acceptsKickbackTo: ['intro'] },
              page: { needs: 'intro-review', job: writer('page.md'), file: 'page.md' },
              'page-goal': { needs: 'page', job: goalCheck(goalSeat(page), { target: 'page', text: BRIEF }), acceptsKickbackTo: ['page'] },
              'page-review': { needs: 'page-goal', job: panel('page'), acceptsKickbackTo: ['page'] },
            },
          });
        })();
      const result = await run(job, { cwd: workDir() });
      expect(result.outcome.status, form).toBe('pass');
      expect(judged, form).toHaveLength(2);
      expect(judgeInput(judged[0]!).how.goal, form).toEqual(intro.requirements);
      expect(judgeInput(judged[1]!).how.goal, form).toEqual(page.requirements);
    }
    expect(inputs.dag!.map(judgeInput)).toEqual(inputs.workflow!.map(judgeInput));
  });

  it('the how: who raised each finding, by the id its question uses', async () => {
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[REVISE]],
      refine: { replies: [{ stop_reason: { choice: 'holds' } }] },
    }, { status: 'pass', builds: 1, judged: 1 });
    for (const { form, judge: prompts } of runs) {
      expect(judgeInput(prompts[0]!).how.findings, form).toEqual([{ id: 'finding-1', reviewer: 'write-1', ...FINDING }]);
    }
  });

  it('the when: every earlier round\'s findings, with the judge\'s own decision on each and its reason', async () => {
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[{ status: 'revise', summary: 'two findings', findings: [REAL, TASTE] }]],
      refine: { replies: [perFinding(), { stop_reason: { choice: 'holds' } }] },
    }, { status: 'pass', builds: 2, judged: 2 });
    for (const { form, judge: prompts } of runs) {
      expect(judgeInput(prompts[1]!).when.rounds, form).toMatchObject([{
        round: 1,
        decision: 'the judge acts on 1 of 2 findings',
        findings: [
          { ...REAL, decision: 'act', reason: 'a reader cannot tell who the page is for' },
          { ...TASTE, decision: 'skip', reason: 'a matter of taste' },
        ],
      }]);
    }
  });

  it('a change over the size limit is cut, and the judge and the record say what was cut', async () => {
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[REVISE]],
      edit: (dir) => writeFileSync(join(dir, 'page.md'), 'x'.repeat(10_000)),
      judgeContextLimit: 2_000,
      refine: { replies: [{ stop_reason: { choice: 'holds' } }] },
    }, { status: 'pass', builds: 1, judged: 1 });
    for (const { form, judge: prompts, events } of runs) {
      const packet = judgeInput(prompts[0]!);
      const kept = (packet.what.draft as string).length;
      expect(kept, form).toBeGreaterThan(0);
      expect(packet.cut, form).toEqual([`the content of page.md: kept the first ${kept} of 10000 characters`]);
      expect(JSON.stringify(packet).length, form).toBeLessThanOrEqual(2_000);
      const judged = events.filter((e): e is Extract<LoopEvent, { kind: 'refine:judge' }> => e.kind === 'refine:judge');
      expect(judged[0]!.packet, form).toEqual({ size: JSON.stringify(packet).length, cut: packet.cut });
    }
  });

  it('a check\'s output over the size limit is cut, so the whole packet stays within it', async () => {
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[PASS]],
      check: ['node', '-e', 'console.log("FAIL ".repeat(12000));process.exit(1)'],
      // The check's failure is also this round's finding, which is never cut.
      judgeContextLimit: 6_000,
      refine: { replies: [{ stop_reason: { choice: 'holds' } }] },
    }, { status: 'pass', builds: 1, judged: 1 });
    for (const { form, judge: prompts } of runs) {
      const packet = judgeInput(prompts[0]!);
      expect(JSON.stringify(packet).length, form).toBeLessThanOrEqual(6_000);
      const [check] = packet.how.checks as { output: string }[];
      expect(check!.output, form).toContain('FAIL FAIL');
      const [note] = packet.cut ?? [];
      const [, kept, of] = /^the output of the check "check": kept the first (\d+) of (\d+) characters$/.exec(note ?? '') ?? [];
      expect(Number(kept), form).toBe(check!.output.length);
      expect(Number(of), form).toBeGreaterThan(Number(kept));
      expect(packet.cut, form).toHaveLength(1);
    }
  });

  it('earlier rounds over the size limit are cut oldest first, so the whole packet stays within it', async () => {
    const long = { status: 'revise', summary: 'one finding', findings: [{ severity: 'should-fix', evidence: 'the title is vague '.repeat(60) }] };
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[long]],
      judgeContextLimit: 4_000,
      refine: { replies: [{ stop_reason: { choice: 'continue' } }, { stop_reason: { choice: 'continue' } }, { stop_reason: { choice: 'continue' } }, { stop_reason: { choice: 'holds' } }] },
    }, { status: 'pass', builds: 4, judged: 4 });
    for (const { form, judge: prompts } of runs) {
      const packet = judgeInput(prompts[3]!);
      expect(JSON.stringify(packet).length, form).toBeLessThanOrEqual(4_000);
      const rounds = (packet.when.rounds as { round: number }[]).map(({ round }) => round);
      expect(rounds.length, form).toBeLessThan(3);
      // The rounds kept are the latest ones.
      expect(rounds, form).toEqual([3, 2, 1].slice(0, rounds.length).reverse());
      expect(packet.cut, form).toEqual([rounds.length
        ? `the earlier rounds: kept the last ${rounds.length} of 3 rounds`
        : 'the earlier rounds: left out (3 rounds)']);
      // The findings to decide are never cut.
      expect(packet.how.findings, form).toEqual([{ id: 'finding-1', reviewer: 'write-1', ...long.findings[0] }]);
    }
  });

  it('a packet still over the size limit once everything else is cut says so', async () => {
    const runs = await sameInEveryForm(['workflow', 'dag'], {
      reviews: [[REVISE]],
      judgeContextLimit: 10,
      refine: { replies: [{ stop_reason: { choice: 'holds' } }] },
    }, { status: 'pass', builds: 1, judged: 1 });
    for (const { form, judge: prompts } of runs) {
      const packet = judgeInput(prompts[0]!);
      expect(packet.how.findings, form).toEqual([{ id: 'finding-1', reviewer: 'write-1', ...FINDING }]);
      expect(packet.cut?.at(-1), form).toBe('what is left is never cut, so the packet is over the limit: the findings to decide, and the names, numbers and commands around them');
    }
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
    expect(judgeInput(built.judge[1]!)).toMatchObject({ when: { round: 2, rounds: [{ round: 1 }], skipped: [{ finding: { evidence: TASTE.evidence } }] } });
    const second = judgeInput(built.judge[2]!).when;
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
    expect(judgeInput(judged[1]!)).toMatchObject({ when: { round: 1, cap: 1 } });
    expect(judgeInput(judged[1]!).when).not.toHaveProperty('lastRound');
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
    return { cwd, callbacks, writer, judge: judgeCalls, start, resume };
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
    expect(judgeInput(page.judge[0]!)).toMatchObject({ how: { findings: [{ severity: 'block', evidence: 'Say who the page is for.' }] }, when: { round: 1 } });
    expect(page.writer).toHaveLength(2);
    expect(page.writer[1]).toContain('Say who the page is for.');
  });

  it('compares the work with the workspace from before the writer ran, after a pause before the judge\'s first round', async () => {
    const page = await waitingForPerson();
    await notesRepo(page.cwd);
    expect((await page.start()).status).toBe('paused');
    expect(page.judge).toHaveLength(0);
    await answer(page.callbacks, refuse('Say who the page is for.'));
    expect((await page.resume()).status).toBe('paused');
    expect(page.judge).toHaveLength(1);
    expect(judgeInput(page.judge[0]!).what.changedFiles).toEqual([{ path: 'page.md', added: 1, removed: 0 }]);
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
      how: { findings: [{ evidence: 'Name the reader in the title.' }] },
      when: { round: 2, rounds: [{ round: 1, findings: [{ evidence: 'Say who the page is for.' }] }] },
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
    expect(judgeInput(page.judge[1]!)).toMatchObject({ when: { round: 2, cap: 1, lastRound: true } });
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

describe('the goal check\'s verdicts across a resume', () => {
  it('a later step that sends the work back after a resume gives the judge the verdicts on the reused work, the same in both forms', async () => {
    const met = { requirements: [{ requirement: 'Says who it is for', verdict: 'met', evidence: 'page.md:1 names new staff' }] };
    const inputs: Partial<Record<'workflow' | 'dag', string[]>> = {};
    for (const form of ['workflow', 'dag'] as const) {
      const cwd = workDir();
      const store = await createStoredRunFixture('one-round-rule');
      stores.push(store);
      const callbacks = await createStoredCallbackClient(store.storage, store.runId);
      const writer: string[] = [];
      const judged: string[] = [];
      inputs[form] = judged;
      const writerEngine = new MockEngine((req: AgentRequest) => {
        writer.push(req.prompt);
        writeFileSync(join(req.cwd!, 'page.md'), `draft ${writer.length}`);
        return JSON.stringify({ status: 'pass', summary: `wrote draft ${writer.length}` });
      });
      const reviewerEngine = new MockEngine(() => JSON.stringify(PASS));
      // The person's question is about the review's summary, which stays the
      // same, so the rebuilt work meets the same refusal; the judge lets it stand.
      const judgeSeat = seat(scripted([{ stop_reason: { choice: 'continue' } }, { stop_reason: { choice: 'holds' } }], judged), 'judge-mock');
      const goalSeat = seat(scripted([met], []), 'goal-mock', ['Read']);
      // A resume builds the job again, as a fresh worker would.
      const job = (): Job => form === 'workflow' ? workflow('page', {
        brief: BRIEF,
        roles: {
          writer: seat(writerEngine, 'writer-mock', ['Write']),
          reviewer: [seat(reviewerEngine, 'reviewer-1', ['Read'])],
          approver: person('Is the page ready?'),
        },
        stages: [
          stage('write', { agent: 'writer', writes: 'page.md', reviewedBy: 'reviewer', refine: judge(judgeSeat), goal: goalSeat }),
          stage('approve', { input: 'approver', sendsBackTo: 'write' }),
        ],
      }) : dag({
        name: 'page',
        brief: BRIEF,
        useCase: 'a reader gets a clear, short page.',
        maxKickbacks: { write: judge(judgeSeat) },
        nodes: {
          write: {
            job: agentJob({ label: 'write', engine: writerEngine, model: 'writer-mock', workspaceMode: 'write', consumeFeedback: true, prompt: 'Write page.md.', outcome: (text) => outcomeFromAgentText(text) }),
            file: 'page.md',
          },
          goal: { needs: 'write', job: goalCheck(goalSeat, { target: 'write', text: BRIEF }), acceptsKickbackTo: ['write'] },
          review: {
            needs: 'goal',
            acceptsKickbackTo: ['write'],
            job: reviewPanel({
              label: 'write',
              target: 'write',
              reviewers: [{ name: 'write-1', job: agentJob({ label: 'write-1', engine: reviewerEngine, model: 'reviewer-1', workspaceMode: 'read', tools: ['Read'], prompt: 'Review page.md.', outcome: (text) => outcomeFromAgentText(text) }) }],
            }),
          },
          approve: { needs: 'review', acceptsKickbackTo: ['write'], job: approval('approve', { question: 'Is the page ready?', target: 'write' }) },
        },
      });
      const recordTo = join(cwd, 'record.jsonl');
      expect((await run(job(), { cwd, recordTo, callbacks })).outcome.status, form).toBe('paused');
      expect(writer, form).toHaveLength(1);
      expect(judged, form).toHaveLength(0);
      const [question] = await callbacks.listPending();
      const claim = await callbacks.claim(question!.requestId, 'person');
      if (!claim.ok) throw new Error('could not claim the question');
      expect(await callbacks.submit(question!.requestId, claim.claimToken, 'person', question!.digest, { approved: false, note: 'Say who the page is for.' })).toMatchObject({ ok: true });

      expect((await run(job(), { cwd, recordTo, callbacks, resume: true })).outcome.status, form).toBe('pass');
      expect(writer, form).toHaveLength(2);
      expect(judged, form).toHaveLength(2);
      for (const prompt of judged) expect(judgeInput(prompt).how.goal, form).toEqual(met.requirements);
    }
    expect(inputs.dag!.map(judgeInput)).toEqual(inputs.workflow!.map(judgeInput));
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

  it('a failed check the judge let stand still reads as failed after a pause for a person, the same in both forms', async () => {
    const inputs: Partial<Record<'workflow' | 'dag', string[]>> = {};
    for (const form of ['workflow', 'dag'] as const) {
      const cwd = workDir();
      const store = await createStoredRunFixture('one-round-rule');
      stores.push(store);
      const callbacks = await createStoredCallbackClient(store.storage, store.runId);
      let builds = 0;
      const writerEngine = new MockEngine((req: AgentRequest) => {
        builds += 1;
        writeFileSync(join(req.cwd!, 'page.md'), `draft ${builds}`);
        return JSON.stringify({ status: 'pass', summary: `wrote draft ${builds}` });
      });
      const reviewerEngine = new MockEngine(() => JSON.stringify(PASS));
      const judged: string[] = [];
      inputs[form] = judged;
      const judgeSeat = seat(scripted([{ stop_reason: { choice: 'holds' } }], judged), 'judge-mock');
      const check = ['node', '-e', 'console.log("FAIL: first check");process.exit(1)'];
      const secondCheck = ['node', '-e', 'console.log("FAIL: second check");process.exit(1)'];
      // A resume builds the job again, as a fresh worker would.
      const job = (): Job => form === 'workflow' ? workflow('page', {
        brief: BRIEF,
        roles: {
          writer: seat(writerEngine, 'writer-mock', ['Write']),
          reviewer: [seat(reviewerEngine, 'reviewer-1', ['Read'])],
          approver: person('Is the page ready?'),
        },
        stages: [
          stage('write', { agent: 'writer', writes: 'page.md', reviewedBy: 'reviewer', refine: judge(judgeSeat) }),
          stage('check', { run: check, sendsBackTo: 'write' }),
          stage('approve', { input: 'approver' }),
          stage('second-check', { run: secondCheck, sendsBackTo: 'write' }),
        ],
      }) : dag({
        name: 'page',
        brief: BRIEF,
        useCase: 'a reader gets a clear, short page.',
        maxKickbacks: { write: judge(judgeSeat) },
        nodes: {
          write: {
            job: agentJob({ label: 'write', engine: writerEngine, model: 'writer-mock', workspaceMode: 'write', consumeFeedback: true, prompt: 'Write page.md.', outcome: (text) => outcomeFromAgentText(text) }),
            file: 'page.md',
          },
          review: {
            needs: 'write',
            acceptsKickbackTo: ['write'],
            job: reviewPanel({
              label: 'write',
              target: 'write',
              reviewers: [{ name: 'write-1', job: agentJob({ label: 'write-1', engine: reviewerEngine, model: 'reviewer-1', workspaceMode: 'read', tools: ['Read'], prompt: 'Review page.md.', outcome: (text) => outcomeFromAgentText(text) }) }],
            }),
          },
          check: { needs: 'review', acceptsKickbackTo: ['write'], job: commandJob('check', check, { target: 'write' }) },
          approve: { needs: 'check', job: approval('approve', { question: 'Is the page ready?' }) },
          'second-check': { needs: 'approve', acceptsKickbackTo: ['write'], job: commandJob('second-check', secondCheck, { target: 'write' }) },
        },
      });
      const recordTo = join(cwd, 'record.jsonl');
      expect((await run(job(), { cwd, recordTo, callbacks })).outcome.status, form).toBe('paused');
      expect(judged, form).toHaveLength(1);
      const [question] = await callbacks.listPending();
      const claim = await callbacks.claim(question!.requestId, 'person');
      if (!claim.ok) throw new Error('could not claim the question');
      expect(await callbacks.submit(question!.requestId, claim.claimToken, 'person', question!.digest, { approved: true })).toMatchObject({ ok: true });

      expect((await run(job(), { cwd, recordTo, callbacks, resume: true })).outcome.status, form).toBe('pass');
      expect(builds, form).toBe(1);
      expect(judged, form).toHaveLength(2);
      const checks = judgeInput(judged[1]!).how.checks as { name: string; status: string; output?: string }[];
      expect(checks.map(({ name, status }) => ({ name, status })), form).toEqual([
        { name: 'check', status: 'fail' },
        { name: 'second-check', status: 'fail' },
      ]);
      expect(checks[0]!.output, form).toContain('FAIL: first check');
    }
    expect(inputs.dag!.map(judgeInput)).toEqual(inputs.workflow!.map(judgeInput));
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
