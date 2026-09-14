import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { approval, createCallbackClient, dag, fnJob, pipeline, run } from '../src/api.ts';
import type { LoopEvent, RunResult } from '../src/api.ts';

type MonitorEvent = Extract<LoopEvent, { kind: 'monitor' }>;
const monitorEvents = (events: LoopEvent[]): MonitorEvent[] =>
  events.filter((e): e is MonitorEvent => e.kind === 'monitor');

const get = async (url: string) => {
  const res = await fetch(url);
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() };
};

let home: string;
let previousHome: string | undefined;
const opened: RunResult[] = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'obversa-monitor-'));
  previousHome = process.env.OBVERSA_HOME;
  process.env.OBVERSA_HOME = home;
});
afterEach(async () => {
  for (const result of opened.splice(0)) await result.monitor?.close();
  if (previousHome === undefined) delete process.env.OBVERSA_HOME; else process.env.OBVERSA_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('the run monitor', () => {
  it('is off by default: no server, no event', async () => {
    const events: LoopEvent[] = [];
    const result = await run(fnJob('quiet', () => {}), { onEvent: (e) => events.push(e) });
    expect(monitorEvents(events)).toHaveLength(0);
    expect(result.monitor).toBeUndefined();
  });

  it('binds a free localhost port, says so once as an event, and serves the graph while the run is on', async () => {
    const events: LoopEvent[] = [];
    let seen: { state: Record<string, unknown>; page: string } | undefined;
    const job = dag({
      name: 'watched',
      nodes: {
        analyse: fnJob('analyse', () => 'read the ticket'),
        implement: {
          needs: 'analyse',
          desc: 'Write the change.',
          job: fnJob('implement', async () => {
            const url = monitorEvents(events)[0]!.url;
            const state = JSON.parse((await get(`${url}state`)).body) as Record<string, unknown>;
            const page = (await get(url)).body;
            seen = { state, page };
            return 'wrote it';
          }),
        },
      },
    });
    const result = await run(job, { monitor: true, onEvent: (e) => events.push(e) });
    opened.push(result);
    const announced = monitorEvents(events);
    expect(announced).toHaveLength(1);
    expect(announced[0]!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(result.monitor?.url).toBe(announced[0]!.url);
    expect(seen).toBeDefined();
    expect(seen!.state.status).toBe('running');
    const nodes = seen!.state.nodes as Record<string, { phase: string; needs?: string[]; desc?: string }>;
    expect(Object.keys(nodes).sort()).toEqual(['analyse', 'implement']);
    expect(nodes.analyse!.phase).toBe('done');
    expect(nodes.implement!.phase).toBe('running');
    expect(nodes.implement!.needs).toEqual(['analyse']);
    expect(nodes.implement!.desc).toBe('Write the change.');
    expect(seen!.page).toContain('<!doctype html>');
    expect(seen!.page).toContain('watched');
    // After the run the page still answers with the final state.
    const final = JSON.parse((await get(`${result.monitor!.url}state`)).body) as { status: string; nodes: Record<string, { phase: string }> };
    expect(final.status).toBe('done');
    expect(final.nodes.implement!.phase).toBe('done');
  });

  it('is on under supervise unless told otherwise', async () => {
    const on: LoopEvent[] = [];
    const first = await run(fnJob('a', () => {}), { supervise: true, onEvent: (e) => on.push(e) });
    opened.push(first);
    expect(monitorEvents(on)).toHaveLength(1);
    const off: LoopEvent[] = [];
    const second = await run(fnJob('a', () => {}), { supervise: true, monitor: false, onEvent: (e) => off.push(e) });
    opened.push(second);
    expect(monitorEvents(off)).toHaveLength(0);
  });

  it('puts the address in the record and never on stdout', async () => {
    const record = join(home, 'run.jsonl');
    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;
    let result: RunResult;
    try {
      result = await run(fnJob('a', () => {}), { monitor: true, recordTo: record });
    } finally {
      process.stdout.write = original;
    }
    opened.push(result!);
    const lines = readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { kind: string; url?: string });
    const announced = lines.filter((line) => line.kind === 'monitor');
    expect(announced).toHaveLength(1);
    expect(announced[0]!.url).toBe(result!.monitor!.url);
    expect(writes.join('')).not.toContain(result!.monitor!.url);
  });

  it('lets a person answer a pending question, and nothing else', async () => {
    const client = createCallbackClient();
    const result = await run(pipeline('ship', [
      { name: 'implement', job: fnJob('implement', () => 'report.csv') },
      { name: 'approve', job: approval('approve', { question: 'Ship this change?', input: { change: 'abc' } }) },
    ]), { monitor: true, callbacks: client });
    opened.push(result);
    expect(result.outcome.status).toBe('paused');
    const url = result.monitor!.url;
    const state = JSON.parse((await get(`${url}state`)).body) as { pending: Array<{ requestId: string; decisionText: string }> };
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]!.decisionText).toBe('Ship this change?');
    const answered = await fetch(`${url}answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: state.pending[0]!.requestId, response: { approved: true } }),
    });
    expect(answered.status).toBe(200);
    expect(client.listPending()).toHaveLength(0);
    const again = await run(pipeline('ship', [
      { name: 'implement', job: fnJob('implement', () => 'report.csv') },
      { name: 'approve', job: approval('approve', { question: 'Ship this change?', input: { change: 'abc' } }) },
    ]), { callbacks: client });
    expect(again.outcome.status).toBe('pass');
    // No other control exists on the page.
    const forbidden = await fetch(`${url}state`, { method: 'DELETE' });
    expect(forbidden.status).toBe(405);
    const unknown = await fetch(`${url}stop`, { method: 'POST' });
    expect(unknown.status).toBe(404);
  });

  it('closes on request, and the port is released', async () => {
    const result = await run(fnJob('a', () => {}), { monitor: true });
    const url = result.monitor!.url;
    expect((await get(`${url}state`)).status).toBe(200);
    await result.monitor!.close();
    await expect(fetch(`${url}state`)).rejects.toThrow();
  });
});
