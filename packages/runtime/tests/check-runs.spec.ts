/**
 * A failed check runs once more on the same tree before it counts: a pass
 * the second time is a flaky check, not a round. A writer may answer a
 * failed check with no change and its evidence; the check then runs again,
 * and a further failure pauses the run, naming the check and quoting the
 * evidence. A failed check's record and finding keep the failure: the
 * failing test by name, the lines that report it, and the end of each
 * stream, with the whole output in a file beside the record.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { agentJob, commandJob, dag, review, run, type Job, type LoopEvent, type Outcome } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const workDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-runs-'));
  dirs.push(dir);
  return dir;
};

/** A check that fails until it has run `failures` times, counting its runs in a file. */
function countingCheck(dir: string, failures: number): string[] {
  const script = join(dir, 'check.mjs');
  writeFileSync(script, [
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    `const counter = ${JSON.stringify(join(dir, 'runs.txt'))};`,
    "const runs = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;",
    'writeFileSync(counter, String(runs));',
    `if (runs <= ${failures}) { console.log('run ' + runs + ' failed'); process.exitCode = 1; }`,
  ].join('\n'));
  return [process.execPath, script];
}

const runsOf = (dir: string) => Number(readFileSync(join(dir, 'runs.txt'), 'utf8'));

/** A check named `name` that fails on the runs `failing` lists, counting its runs in its own file. */
function checkFailingOn(dir: string, name: string, failing: readonly number[]): string[] {
  const script = join(dir, `${name}.mjs`);
  writeFileSync(script, [
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    `const counter = ${JSON.stringify(join(dir, `${name}.txt`))};`,
    "const runs = (existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0) + 1;",
    'writeFileSync(counter, String(runs));',
    `if (${JSON.stringify(failing)}.includes(runs)) { console.log('${name} run ' + runs + ' failed'); process.exitCode = 1; }`,
  ].join('\n'));
  return [process.execPath, script];
}

const runsNamed = (dir: string, name: string) => Number(readFileSync(join(dir, `${name}.txt`), 'utf8'));

/** One step that runs its checks in order and stops at the first that does not pass. */
const inOrder = (jobs: readonly Job[]): Job => async (ctx) => {
  for (const job of jobs) {
    const outcome = await job(ctx);
    if (outcome.status !== 'pass') return outcome;
  }
  return { status: 'pass', summary: `${jobs.length} check(s) passed` };
};

describe('a failed check runs again before it counts', () => {
  it('passes a check that fails once and passes on its second run, and marks it flaky', async () => {
    const cwd = workDir();
    const events: LoopEvent[] = [];
    const builds: number[] = [];
    const { outcome } = await run(dag({
      name: 'deliver',
      nodes: {
        build: { refine: review({ rounds: 2 }), job: async () => { builds.push(1); return { status: 'pass' as const }; } },
        checks: { needs: ['build'], sendsBackTo: ['build'], job: commandJob('check-1', countingCheck(cwd, 1), { target: 'build' }) },
      },
    }), { cwd, onEvent: (event) => events.push(event) });

    expect(outcome.status).toBe('pass');
    expect(builds).toHaveLength(1);
    expect(runsOf(cwd)).toBe(2);
    const check = (outcome.data as Record<string, Outcome>).checks!;
    expect(check.command?.flaky).toBe(true);
    expect(check.summary).toContain('failed, then passed when run again on the same tree: the check is flaky');
    expect(check.data).toContain('run 1 failed');
    const results = events.filter((event) => event.kind === 'condition:result' && event.label === 'check-1');
    expect(results).toHaveLength(2);
  });

  const withWriter = (cwd: string, failures: number) => {
    const prompts: string[] = [];
    const writer = new MockEngine((request) => {
      prompts.push(request.prompt);
      return 'The change does not cause this: the check fails on the base tree too (evidence: run on main exits 1).';
    });
    return {
      prompts,
      job: dag({
        name: 'deliver',
        nodes: {
          build: { refine: review({ rounds: 3 }), job: agentJob({ label: 'build', engine: writer, prompt: 'Build it.', workspaceMode: 'write', consumeFeedback: true }) },
          checks: { needs: ['build'], sendsBackTo: ['build'], job: commandJob('check-1', countingCheck(cwd, failures), { target: 'build' }) },
        },
      }),
    };
  };

  it('lets a writer answer a failed check with no change, and goes on when the check then passes', async () => {
    const cwd = workDir();
    const { prompts, job } = withWriter(cwd, 2);
    const { outcome } = await run(job, { cwd });

    expect(outcome.status).toBe('pass');
    expect(prompts).toHaveLength(2);
    expect(runsOf(cwd)).toBe(3);
  });

  it('pauses, naming the check and quoting the evidence, when the check fails again after a no-change answer', async () => {
    const cwd = workDir();
    const { job } = withWriter(cwd, 99);
    const { outcome } = await run(job, { cwd });

    expect(outcome.status).toBe('paused');
    // Two runs, the writer's answer, then one more run on the same tree.
    expect(runsOf(cwd)).toBe(3);
    const check = (outcome.data as Record<string, Outcome>).checks!;
    expect(check.status).toBe('paused');
    expect(check.summary).toContain('check.mjs` failed again on the tree the writer left unchanged');
    expect(check.summary).toContain('evidence: run on main exits 1');
  });
});

describe('a no-change answer covers only the check it answered', () => {
  const twoChecks = (cwd: string, first: readonly number[], second: readonly number[]) => {
    const prompts: string[] = [];
    const writer = new MockEngine((request) => {
      prompts.push(request.prompt);
      return 'The change does not cause this: the check fails on the base tree too.';
    });
    return {
      prompts,
      job: dag({
        name: 'deliver',
        nodes: {
          build: { refine: review({ rounds: 3 }), job: agentJob({ label: 'build', engine: writer, prompt: 'Build it.', workspaceMode: 'write', consumeFeedback: true }) },
          checks: {
            needs: ['build'],
            sendsBackTo: ['build'],
            job: inOrder([
              commandJob('check-1', checkFailingOn(cwd, 'first', first), { target: 'build' }),
              commandJob('check-2', checkFailingOn(cwd, 'second', second), { target: 'build' }),
            ]),
          },
        },
      }),
    };
  };

  it('still runs another check once more when it flakes after a no-change answer to the second', async () => {
    const cwd = workDir();
    // Round 1: the first passes, the second fails twice. Round 2: the first flakes, the second passes.
    const { prompts, job } = twoChecks(cwd, [2], [1, 2]);
    const { outcome } = await run(job, { cwd });

    expect(outcome.status).toBe('pass');
    expect(prompts).toHaveLength(2);
    expect(runsNamed(cwd, 'first')).toBe(3);
    expect(runsNamed(cwd, 'second')).toBe(3);
    const check = (outcome.data as Record<string, Outcome>).checks!;
    expect(check.status).toBe('pass');
  });

  it('sends another check that fails twice after a no-change answer to the second back as a new finding', async () => {
    const cwd = workDir();
    // Round 2: the first fails twice, which is its own finding, not a pause.
    const { prompts, job } = twoChecks(cwd, [2, 3], [1, 2]);
    const { outcome } = await run(job, { cwd });

    expect(outcome.status).toBe('pass');
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain('first run 3 failed');
    expect(runsNamed(cwd, 'first')).toBe(4);
    expect(runsNamed(cwd, 'second')).toBe(3);
  });
});

describe("a failed check's output", () => {
  it('keeps the failure line, the summary and the failing test, and the whole output beside the record', async () => {
    const cwd = workDir();
    const script = join(cwd, 'suite.mjs');
    writeFileSync(script, [
      `process.stdout.write(${JSON.stringify(' ✓ passes a check\n'.repeat(1_100))});`,
      "process.stdout.write(' FAIL  tests/sum.spec.ts > sum > adds two numbers\\n');",
      "process.stdout.write(' Test Files  1 failed | 9 passed (10)\\n      Tests  1 failed | 99 passed (100)\\n');",
      `process.stderr.write(${JSON.stringify('[log] a line the suite printed\n'.repeat(650))});`,
      'process.exitCode = 1;',
    ].join('\n'));
    const record = join(cwd, 'records', 'run.jsonl');

    const { outcome } = await run(commandJob('check-1', [process.execPath, script], { target: 'build', outputLimit: 5_000 }), { cwd, recordTo: record });

    expect(outcome.status).toBe('fail');
    const output = String(outcome.data);
    // The finding the build gets quotes the same output.
    expect(outcome.revision?.findings?.[0]?.evidence).toBe(output);
    expect(output).toContain('failing tests:\n- tests/sum.spec.ts > sum > adds two numbers');
    expect(output).toContain(' FAIL  tests/sum.spec.ts > sum > adds two numbers');
    expect(output).toContain('Tests  1 failed | 99 passed (100)');
    expect(output).toMatch(/stdout \(the last \d+ of \d+ characters\):/);
    expect(output).toMatch(/stderr \(the last \d+ of \d+ characters\):/);
    // It failed twice; the second run's output is the one that counts.
    expect(existsSync(join(cwd, 'records', 'run.checks', 'round-1-check-1-run-1.log'))).toBe(true);
    const file = join(cwd, 'records', 'run.checks', 'round-1-check-1-run-2.log');
    // Named from the workspace, where the record sits.
    expect(output).toContain('the whole output is in records/run.checks/round-1-check-1-run-2.log');
    expect(existsSync(file)).toBe(true);
    const whole = readFileSync(file, 'utf8');
    expect(whole).toContain(' ✓ passes a check\n'.repeat(1_100));
    expect(whole).toContain('[log] a line the suite printed\n'.repeat(650));
  });
});
