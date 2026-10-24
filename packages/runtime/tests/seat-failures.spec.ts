/**
 * A seat that could not answer — it stalled, timed out, hit a login error,
 * ended with no exit status, ran a process the runner could not watch, or
 * found its CLI's version moved — runs once
 * more, then its next candidate answers, and the record says which seat
 * answered and why the first did not. A reviewer that never answers is not
 * a review: the panel decides on the reviewers that did.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { agentJob, EngineError, reviewPanel, run, type AgentRequest, type Engine, type LoopEvent, type TeamSeat } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';
import { OwnedCommandError } from '../src/engines/command-runner.ts';
import { outcomeFromAgentText } from '../src/workflow-support.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const workDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'seat-failures-'));
  dirs.push(dir);
  return dir;
};

/** An engine that sends no event and never answers until its call is stopped. */
function silentEngine(calls: AgentRequest[]): Engine {
  return {
    name: 'silent',
    run: (request, _onEvent, signal) => {
      calls.push(request);
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new EngineError({ kind: 'aborted', message: 'stopped' })), { once: true });
      });
    },
  };
}

const seatOf = (engine: Engine, model: string): TeamSeat => ({
  engine,
  identity: { adapter: 'mock', provider: model, modelFamily: model, model, tools: ['Read'] },
});

const PASS = JSON.stringify({ status: 'pass', summary: 'clean' });

describe('a seat that could not answer', () => {
  it('runs a stalled seat once more, then its candidate, and the record names both', async () => {
    const stalled: AgentRequest[] = [];
    const primary = seatOf(silentEngine(stalled), 'alpha');
    const answered: AgentRequest[] = [];
    const candidate = seatOf(new MockEngine((request) => { answered.push(request); return 'done'; }), 'beta');
    const events: LoopEvent[] = [];

    const { outcome } = await run(agentJob({
      label: 'build',
      engine: primary.engine,
      model: 'alpha',
      identity: primary.identity,
      candidates: [candidate],
      prompt: 'do the work',
      stallMs: 50,
    }), { cwd: workDir(), onEvent: (event) => events.push(event) });

    expect(outcome.status).toBe('pass');
    expect(stalled).toHaveLength(2);
    expect(answered).toHaveLength(1);
    const routes = events.filter((event): event is Extract<LoopEvent, { kind: 'seat:route' }> => event.kind === 'seat:route');
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ requested: { model: 'alpha' }, selected: { model: 'beta' }, failure: 'timeout', reason: 'it sent no engine event for 50 ms' });
  });

  it.each([
    ['a login error', new EngineError({ kind: 'auth', message: 'invalid api key' }), 'a login error: invalid api key'],
    ['a moved CLI version', new EngineError({ kind: 'invalid-config', message: 'observed 1.0.62, pinned 1.0.52', versionMoved: true }), "its CLI's version moved: observed 1.0.62, pinned 1.0.52"],
    ['no exit status', new EngineError({ kind: 'unknown', message: 'devin exited ?', noExitStatus: true }), 'it ended with no result and no exit status: devin exited ?'],
    ['a process the runner could not watch', new OwnedCommandError('PROCESS_INSPECTION', "EACCES: permission denied, open '/dev/fd/38'"), "its process could not be watched, so it gave no result: EACCES: permission denied, open '/dev/fd/38'"],
    ['a version check the runner could not watch', new EngineError({ kind: 'unknown', message: 'Codex version observation failed', cause: new OwnedCommandError('PROCESS_INSPECTION', 'ps failed') }), 'its process could not be watched, so it gave no result: Codex version observation failed'],
  ])('moves to the candidate after %s and one retry', async (_label, thrown, reason) => {
    let calls = 0;
    const primary = seatOf(new MockEngine(() => { calls += 1; throw thrown; }), 'alpha');
    const candidate = seatOf(new MockEngine(() => 'done'), 'beta');
    const events: LoopEvent[] = [];

    const { outcome } = await run(agentJob({
      label: 'build', engine: primary.engine, model: 'alpha', identity: primary.identity, candidates: [candidate], prompt: 'do the work',
    }), { cwd: workDir(), onEvent: (event) => events.push(event) });

    expect(outcome.status).toBe('pass');
    expect(calls).toBe(2);
    expect(events.find((event) => event.kind === 'seat:route')).toMatchObject({ selected: { model: 'beta' }, reason });
  });
});

describe('a reviewer that never answers', () => {
  const panel = (other: string) => {
    const silent: AgentRequest[] = [];
    return {
      silent,
      job: reviewPanel({
        label: 'review',
        target: 'build',
        pass: 1,
        reviewers: [
          { name: 'quiet', job: agentJob({ label: 'quiet', engine: silentEngine(silent), prompt: 'Review.', stallMs: 50, outcome: (text) => outcomeFromAgentText(text, 'build') }) },
          { name: 'other', job: agentJob({ label: 'other', engine: new MockEngine(() => other), prompt: 'Review.', outcome: (text) => outcomeFromAgentText(text, 'build') }) },
        ],
      }),
    };
  };

  it('costs no round: the panel passes on the reviewer that answered', async () => {
    const { silent, job } = panel(PASS);
    const { outcome } = await run(job, { cwd: workDir() });

    expect(silent).toHaveLength(2);
    expect(outcome.status).toBe('pass');
    expect(outcome.revision).toBeUndefined();
  });

  it('sends back only what the answering reviewer found', async () => {
    const { job } = panel(JSON.stringify({ status: 'revise', summary: 'fix', findings: [{ severity: 'block', evidence: 'app.ts:1 wrong' }] }));
    const { outcome } = await run(job, { cwd: workDir() });

    expect(outcome.status).toBe('fail');
    expect(outcome.revision?.findings?.map((finding) => finding.evidence)).toEqual(['app.ts:1 wrong']);
  });
});
