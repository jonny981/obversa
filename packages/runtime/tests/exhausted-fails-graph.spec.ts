import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { dag, exitCodeFor, failed, fnJob, loop, person, revisionRequest, run, stage, workflow } from '../src/api.ts';
import type { AgentRequest, InteractionBinding, Outcome, TeamSeat, WorkflowRole } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'exhausted-'));
  dirs.push(dir);
  return dir;
}

const FINDING = { severity: 'should-fix' as const, evidence: 'page.md:1 the title is vague' };

/** A loop whose review always asks for changes, so it runs out after `max` rounds. */
function neverPasses(name: string, max: number) {
  return loop({
    name,
    max,
    body: fnJob(`${name}-write`, async () => ({ status: 'pass', summary: 'wrote it' })),
    review: fnJob(`${name}-review`, async () => revisionRequest({ reason: 'the title is vague', findings: [FINDING] })),
  });
}

describe('an exhausted node in a dag', () => {
  it('fails the dag, exits non-zero, and keeps the last findings', async () => {
    const result = await run(dag({ name: 'publish', nodes: { draft: neverPasses('draft', 2) } }), { cwd: workDir() });
    expect(result.outcome.status).toBe('fail');
    expect(exitCodeFor(result.outcome)).not.toBe(0);
    expect(result.outcome.summary).toContain('"draft" ran out of rounds');
    expect(result.outcome.summary).toContain('the title is vague');
    const draft = (result.outcome.data as Record<string, Outcome>).draft!;
    expect(draft.status).toBe('exhausted');
    expect(draft.revision?.findings).toEqual([FINDING]);
  });

  it('does not run a node that needs it', async () => {
    let published = 0;
    const result = await run(dag({
      name: 'publish',
      nodes: {
        draft: neverPasses('draft', 2),
        publish: { needs: 'draft', job: fnJob('publish', async () => { published += 1; return { status: 'pass' }; }) },
      },
    }), { cwd: workDir() });
    expect(published).toBe(0);
    expect(result.outcome.status).toBe('fail');
    expect(result.outcome.summary).toContain('"draft" ran out of rounds');
  });

  it('sends nothing back when the last review named a target', async () => {
    let planned = 0;
    const result = await run(dag({
      name: 'publish',
      maxKickbacks: 1,
      nodes: {
        plan: fnJob('plan', async () => { planned += 1; return { status: 'pass' }; }),
        draft: {
          needs: 'plan',
          job: loop({
            name: 'draft',
            max: 2,
            body: fnJob('draft-write', async () => ({ status: 'pass' })),
            review: fnJob('draft-review', async () => revisionRequest({ target: 'plan', reason: 'the plan is thin', findings: [FINDING] })),
          }),
        },
      },
    }), { cwd: workDir() });
    expect(planned).toBe(1);
    expect(result.outcome.status).toBe('fail');
    const draft = (result.outcome.data as Record<string, Outcome>).draft!;
    expect(draft.revision?.target).toBeUndefined();
    expect(draft.revision?.findings).toEqual([FINDING]);
  });

  it('does not fail the dag when the node is optional, and still keeps its findings', async () => {
    const result = await run(dag({
      name: 'publish',
      nodes: {
        draft: { optional: true, job: neverPasses('draft', 2) },
        index: fnJob('index', async () => ({ status: 'pass' })),
      },
    }), { cwd: workDir() });
    expect(result.outcome.status).toBe('pass');
    const draft = (result.outcome.data as Record<string, Outcome>).draft!;
    expect(draft.status).toBe('exhausted');
    expect(draft.revision?.findings).toEqual([FINDING]);
  });
});

function seat(engine: MockEngine, model: string, tools: readonly string[] = []): TeamSeat {
  return { engine, identity: { adapter: 'mock', provider: 'mock', modelFamily: model, model, tools } };
}

describe('a workflow stage reviewed by a panel', () => {
  it('fails the run with the last findings when the panel never clears it', async () => {
    const reviewCalls: AgentRequest[] = [];
    const writer = new MockEngine((req) => {
      writeFileSync(join(req.cwd!, 'page.md'), 'draft');
      return JSON.stringify({ status: 'pass', summary: 'wrote it' });
    });
    const reviewer = new MockEngine((req) => {
      reviewCalls.push(req);
      return JSON.stringify({ status: 'revise', summary: 'one finding', findings: [{ severity: 'should-fix', evidence: 'REVIEW: the title is vague' }] });
    });
    const job = workflow('welcome-page', {
      brief: 'Write a welcome page.',
      roles: { writer: seat(writer, 'writer-mock', ['Write']), reviewer: [seat(reviewer, 'reviewer-mock', ['Read'])] },
      stages: [stage('write', { agent: 'writer', writes: 'page.md', reviewedBy: 'reviewer', refine: 1 })],
    });
    const result = await run(job, { cwd: workDir() });
    expect(reviewCalls.length).toBeGreaterThan(0);
    expect(result.outcome.status).toBe('fail');
    expect(exitCodeFor(result.outcome)).not.toBe(0);
    expect(result.outcome.summary).toContain('"write" ran out of rounds');
    const write = (result.outcome.data as Record<string, Outcome>).write!;
    expect(write.status).toBe('exhausted');
    expect(write.revision?.findings?.map((f) => f.evidence)).toContain('REVIEW: the title is vague');
  });
});

describe('an optional reviewed stage that runs out of rounds', () => {
  const binding: InteractionBinding = {
    id: 'page-review',
    responseSchema: { type: 'object', properties: { feedback: { type: 'object' }, prompt: { type: 'string' } }, required: ['feedback', 'prompt'] },
  };
  const reviewers: Record<string, () => WorkflowRole> = {
    person: () => person('Ready?', { interaction: { ...binding, async answer() { return { feedback: {}, decision: 'changes-requested', prompt: 'The title is vague.' }; } } }),
    panel: () => [seat(new MockEngine(() => JSON.stringify({ status: 'revise', summary: 'one finding', findings: [{ severity: 'should-fix', evidence: 'REVIEW: the title is vague' }] })), 'reviewer-mock', ['Read'])],
  };

  it.each(Object.keys(reviewers))('runs the stage that recovers from it (reviewed by a %s)', async (kind) => {
    let drafts = 0;
    const writer = new MockEngine((req) => {
      drafts += 1;
      writeFileSync(join(req.cwd!, 'page.md'), `draft ${drafts}`);
      return JSON.stringify({ status: 'pass', summary: 'wrote it' });
    });
    let fallbacks = 0;
    const fallback = new MockEngine((req) => {
      fallbacks += 1;
      writeFileSync(join(req.cwd!, 'template.md'), 'welcome');
      return JSON.stringify({ status: 'pass', summary: 'used the template' });
    });
    const job = workflow('welcome-page', {
      brief: 'Write a welcome page.',
      roles: { writer: seat(writer, 'writer-mock', ['Write']), fallback: seat(fallback, 'fallback-mock', ['Write']), reviewer: reviewers[kind]!() },
      stages: [
        stage('write', { agent: 'writer', writes: 'page.md', reviewedBy: 'reviewer', refine: 1, optional: true }),
        stage('template', { agent: 'fallback', writes: 'template.md', needs: 'write', when: failed('write') }),
      ],
    });
    const result = await run(job, { cwd: workDir() });
    expect((result.outcome.data as Record<string, Outcome>).write!.status).toBe('exhausted');
    expect(fallbacks).toBe(1);
    expect(result.outcome.status).toBe('pass');
  });
});
