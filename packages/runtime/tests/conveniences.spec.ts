import { describe, it, expect } from 'vitest';

import {
  approval,
  commandJob,
  createCallbackClient,
  dag,
  directRouter,
  failed,
  fnJob,
  passed,
  pipeline,
  run,
} from '../src/api.ts';
import type { CallbackRequest, Outcome } from '../src/api.ts';

const node = process.execPath;

describe('fnJob returning a string or nothing', () => {
  it('returns pass with the label as the summary when the function returns nothing', async () => {
    const { outcome } = await run(fnJob('tidy', async () => {}));
    expect(outcome.status).toBe('pass');
    expect(outcome.summary).toBe('tidy');
  });

  it('returns pass with the string as the summary', async () => {
    const { outcome } = await run(fnJob('write', () => 'wrote report.csv'));
    expect(outcome.status).toBe('pass');
    expect(outcome.summary).toBe('wrote report.csv');
  });

  it('turns a throw into a fail that keeps the error', async () => {
    const { outcome } = await run(fnJob('write', () => { throw new Error('disk full'); }));
    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toBe('disk full');
    expect(outcome.error?.message).toBe('disk full');
  });

  it('still accepts a full outcome', async () => {
    const { outcome } = await run(fnJob('check', (): Outcome => ({ status: 'fail', summary: 'no header' })));
    expect(outcome).toMatchObject({ status: 'fail', summary: 'no header' });
  });
});

describe('commandJob', () => {
  it('runs a command given as one string and passes on exit 0', async () => {
    const { outcome } = await run(commandJob('ok', `${node} -e 0`));
    expect(outcome.status).toBe('pass');
    expect(outcome.summary).toContain('exited 0');
  });

  it('sends a red command back to its target with the output as the finding', async () => {
    const { outcome } = await run(commandJob(
      'test',
      [node, '-e', 'console.error("add(2, 2) returned 0"); process.exit(1)'],
      { target: 'implement' },
    ));
    expect(outcome.status).toBe('fail');
    expect(outcome.revision?.target).toBe('implement');
    expect(outcome.revision?.findings?.[0]?.evidence).toContain('add(2, 2) returned 0');
    expect(outcome.summary).toContain('add(2, 2) returned 0');
  });

  it('keeps the output out of the summary when capture is off', async () => {
    const { outcome } = await run(commandJob(
      'test',
      [node, '-e', 'console.error("noisy"); process.exit(1)'],
      { capture: false },
    ));
    expect(outcome.status).toBe('fail');
    expect(outcome.summary).not.toContain('noisy');
    expect(outcome.revision).toBeUndefined();
  });

  it('refuses a one-string command that needs quoting', () => {
    expect(() => commandJob('test', `${node} -e "process.exit(1)"`)).toThrow(/array/);
  });

  it('reruns the target inside a dag when the command is red', async () => {
    let implementRuns = 0;
    const { outcome } = await run(dag({
      name: 'command-back',
      maxKickbacks: 1,
      nodes: {
        implement: fnJob('implement', () => { implementRuns += 1; return `attempt ${implementRuns}`; }),
        test: {
          needs: 'implement',
          job: commandJob(
            'test',
            [node, '-e', `process.exit(process.env.RUNS === '1' ? 1 : 0)`],
            { target: 'implement', env: { RUNS: '1' } },
          ),
        },
      },
    }));
    // The env pins RUNS=1 both times, so the command stays red and the kickback cap ends the run.
    expect(implementRuns).toBe(2);
    expect(outcome.status).toBe('fail');
  });
});

describe('passed and failed', () => {
  it('choose the branch from a dependency outcome', async () => {
    const ran: string[] = [];
    const { outcome } = await run(dag({
      name: 'branch',
      nodes: {
        size: { optional: true, job: commandJob('size', [node, '-e', 'process.exit(1)']) },
        small: {
          needs: 'size',
          when: passed('size'),
          job: fnJob('small', () => { ran.push('small'); }),
        },
        large: {
          needs: 'size',
          when: failed('size'),
          job: fnJob('large', () => { ran.push('large'); }),
        },
      },
    }));
    expect(outcome.status).toBe('pass');
    expect(ran).toEqual(['large']);
  });

  it('fail the run when the named node is not a dependency', async () => {
    const { outcome } = await run(dag({
      name: 'branch',
      nodes: {
        a: fnJob('a', () => {}),
        b: { needs: 'a', when: passed('c'), job: fnJob('b', () => {}) },
      },
    }));
    expect(outcome.status).toBe('fail');
    expect(JSON.stringify(outcome)).toMatch(/"c" is not a dependency/);
  });
});

describe('approval', () => {
  it('passes when the person approves', async () => {
    const { outcome } = await run(approval('approve', {
      question: 'Ship this change?',
      answer: () => ({ approved: true }),
    }));
    expect(outcome.status).toBe('pass');
    expect(outcome.summary).toBe('approved: Ship this change?');
    expect(outcome.data).toEqual({ approved: true });
  });

  it('fails carrying the note when the person refuses and nothing owns the fix', async () => {
    const { outcome } = await run(approval('approve', {
      question: 'Ship this change?',
      answer: () => ({ approved: false, note: 'not before the header row is in' }),
    }));
    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toBe('not before the header row is in');
    expect(outcome.revision).toBeUndefined();
  });

  it('sends a refusal back to the target with the note as the finding', async () => {
    const { outcome } = await run(approval('approve', {
      question: 'Ship this change?',
      target: 'implement',
      answer: () => ({ approved: false, note: 'add the header row' }),
    }));
    expect(outcome.status).toBe('fail');
    expect(outcome.revision?.target).toBe('implement');
    expect(outcome.revision?.findings?.[0]?.evidence).toBe('add the header row');
  });

  it('pauses the run with the request pending when nobody has answered', async () => {
    const client = createCallbackClient();
    const { outcome } = await run(approval('approve', { question: 'Ship this change?', input: { change: 'abc' } }), {
      callbacks: client,
    });
    expect(outcome.status).toBe('paused');
    const pending = client.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.decisionText).toBe('Ship this change?');
    expect((outcome.data as CallbackRequest).requestId).toBe(pending[0]?.requestId);
  });

  it('pauses with a client of its own when the run names none', async () => {
    const { outcome } = await run(approval('approve', { question: 'Ship this change?' }));
    expect(outcome.status).toBe('paused');
    expect(typeof (outcome.data as CallbackRequest).requestId).toBe('string');
  });

  it('finds the answer on a resume with the same client and carries on', async () => {
    const client = createCallbackClient();
    const job = approval('approve', { question: 'Ship this change?', input: { change: 'abc' } });
    const first = await run(job, { callbacks: client });
    expect(first.outcome.status).toBe('paused');
    const request = client.listPending()[0]!;
    const submitted = await directRouter(client, request, 'a-person', () => ({ approved: true }));
    expect(submitted.ok).toBe(true);
    const second = await run(job, { callbacks: client });
    expect(second.outcome.status).toBe('pass');
    expect(client.listPending()).toHaveLength(0);
  });

  it('asks about what came before, so a change after a kickback is a new question', async () => {
    const asked: string[] = [];
    let implementRuns = 0;
    const { outcome } = await run(pipeline('ship', [
      { name: 'implement', job: fnJob('implement', () => { implementRuns += 1; return `report.csv v${implementRuns}`; }) },
      {
        name: 'approve',
        job: approval('approve', {
          question: 'Ship this change?',
          target: 'implement',
          answer: (request) => {
            asked.push(request.requestId);
            const about = JSON.stringify(request.input);
            return about.includes('v2') ? { approved: true } : { approved: false, note: 'v1 is not enough' };
          },
        }),
      },
    ], { maxKickbacks: 1 }));
    expect(outcome.status).toBe('pass');
    expect(implementRuns).toBe(2);
    expect(new Set(asked).size).toBe(2);
  });

  it('exposes the callbacks client to every job', async () => {
    let seen = false;
    await run(fnJob('look', (ctx) => { seen = ctx.callbacks !== undefined; }));
    expect(seen).toBe(true);
  });
});
