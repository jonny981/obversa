import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { approval, createCallbackClient, dag, fnJob, kickback, pipeline, run } from '../src/api.ts';
import type { LoopEvent, MonitorState, Outcome, RunResult } from '../src/api.ts';

type MonitorEvent = Extract<LoopEvent, { kind: 'monitor' }>;
const monitorEvents = (events: LoopEvent[]): MonitorEvent[] =>
  events.filter((e): e is MonitorEvent => e.kind === 'monitor');

const get = async (url: string) => {
  const res = await fetch(url);
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() };
};

/** Host the served script's text writes and polling; layout and clicks need a browser. */
async function loadMonitorPage(url: string) {
  const page = await get(url);
  expect(page.status).toBe(200);
  const script = page.body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (script === undefined) throw new Error('the served monitor page has no script');
  // Only IDs present in the served markup exist. No renderer or usage text is supplied here.
  const markup = page.body.slice(0, page.body.indexOf('<script>'));
  const elements = new Map(Array.from(markup.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g), ([tag, id]) => [
    id!,
    { textContent: '', innerHTML: '', hidden: /\bhidden(?:\s|>|=)/.test(tag), addEventListener() {} },
  ] as const));
  let nextPoll: (() => Promise<void>) | undefined;
  let markReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { markReady = resolve; rejectReady = reject; });
  runInNewContext(script, {
    document: { getElementById: (id: string) => elements.get(id) ?? null },
    // Resolve browser-relative URLs, keeping the real response and JSON body unchanged.
    fetch: (path: string, init?: RequestInit) => fetch(new URL(path, url), init).catch((error) => {
      rejectReady(error);
      throw error;
    }),
    setTimeout(callback: () => Promise<void>) {
      nextPoll = callback;
      markReady();
      return 1;
    },
  });
  await ready;
  return {
    text: (id: string) => elements.get(id)?.textContent ?? '',
    visibleText: () => [...elements.values()].filter((element) => !element.hidden)
      .map((element) => element.textContent).join('\n'),
    async poll() {
      const callback = nextPoll;
      nextPoll = undefined;
      if (callback === undefined) throw new Error('the served script did not schedule another poll');
      await callback();
    },
  };
}

let home: string;
let previousHome: string | undefined;
const opened: RunResult[] = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'obversa-monitor-'));
  previousHome = process.env.OBVERSA_HOME;
  process.env.OBVERSA_HOME = home;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const result of opened.splice(0)) await result.monitor?.close();
  if (previousHome === undefined) delete process.env.OBVERSA_HOME; else process.env.OBVERSA_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('the run monitor', () => {
  it('rejects page readiness when the first state fetch fails', async () => {
    const result = await run(fnJob('a', () => {}), { cwd: home, monitor: true });
    opened.push(result);
    const url = result.monitor!.url;
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input) === `${url}state`) return Promise.reject(new Error('initial state fetch failed'));
      return realFetch(input, init);
    });

    await expect(loadMonitorPage(url)).rejects.toThrow('initial state fetch failed');
  });

  it('renders measured usage while running and keeps it after an unknown final call', async () => {
    const events: LoopEvent[] = [];
    let page: Awaited<ReturnType<typeof loadMonitorPage>> | undefined;
    let reportedText = '';
    let reportedStatus = '';
    const result = await run(fnJob('spend', async (ctx) => {
      const monitor = monitorEvents(events)[0];
      if (monitor === undefined) throw new Error('monitor URL was not emitted');
      page = await loadMonitorPage(monitor.url);
      ctx.emit({
        kind: 'engine:usage', ts: 1, path: [], model: 'measured',
        usage: { kind: 'reported', inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 30 },
      });
      await page.poll();
      reportedText = page.visibleText();
      reportedStatus = page.text('status');
      ctx.emit({
        kind: 'engine:usage', ts: 2, path: [], model: 'unmeasured', usage: { kind: 'unknown' },
      });
      return 'usage run finished';
    }), { cwd: home, monitor: true, onEvent: (event) => events.push(event) });
    opened.push(result);

    expect(result.outcome.status, result.outcome.summary).toBe('pass');
    expect(page).toBeDefined();
    const state: MonitorState = JSON.parse((await get(`${result.monitor!.url}state`)).body);
    const usageSummary: string = state.usageSummary;
    expect(usageSummary).toBe('100/20 tok, 30 tok from cache, usage unknown on 1 call');
    // Run the same callback the served page scheduled, after /state has become final.
    await page!.poll();
    const finalText = page!.visibleText();
    expect(reportedStatus).toContain('running');
    expect(reportedText).toContain('100/20 tok');
    expect(reportedText).toContain('30 tok from cache');
    expect(reportedText).not.toContain('usage unknown');
    expect(page!.text('status')).toContain('usage run finished');
    expect(finalText).toContain('100/20 tok');
    expect(finalText).toContain('30 tok from cache');
    expect(finalText).toContain('usage unknown on 1 call');
    expect(finalText).not.toMatch(/[$£€]|\b(?:USD|GBP|EUR)\b/);
  });

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

  it('finishes the page and hands back its handle when the environment fails to start', async () => {
    const events: LoopEvent[] = [];
    const result = await run(fnJob('a', () => {}), {
      monitor: true,
      onEvent: (e) => events.push(e),
      environment: { name: 'broken', up: async () => { throw new Error('no daemon'); } },
    });
    opened.push(result);
    expect(result.outcome.status).toBe('fail');
    expect(monitorEvents(events)).toHaveLength(1);
    expect(result.monitor).toBeDefined();
    const state = JSON.parse((await get(`${result.monitor!.url}state`)).body) as { status: string; outcome?: { status: string } };
    expect(state.status).toBe('done');
    expect(state.outcome?.status).toBe('fail');
  });

  it('refuses a request that did not come from its own page', async () => {
    const client = createCallbackClient();
    const result = await run(approval('approve', { question: 'Ship?', input: { change: 'abc' } }), { monitor: true, callbacks: client });
    opened.push(result);
    const url = result.monitor!.url;
    const requestId = client.listPending()[0]!.requestId;
    const body = JSON.stringify({ requestId, response: { approved: true } });
    // fetch drops a caller's Host header, so the rebound request goes through node:http.
    const rebound = await new Promise<number>((resolve, reject) => {
      request(`${url}state`, { headers: { host: 'rebinding.example' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject).end();
    });
    expect(rebound).toBe(403);
    const crossSite = await fetch(`${url}answer`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body });
    expect(crossSite.status).toBe(415);
    const foreign = await fetch(`${url}answer`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body });
    expect(foreign.status).toBe(403);
    expect(client.listPending()).toHaveLength(1);
  });

  it('answers 400 to a malformed body and 404 to an unknown question', async () => {
    const result = await run(fnJob('a', () => {}), { monitor: true });
    opened.push(result);
    const url = result.monitor!.url;
    const malformed = await fetch(`${url}answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
    expect(malformed.status).toBe(400);
    const unknown = await fetch(`${url}answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'nope#1#x', response: { approved: true } }) });
    expect(unknown.status).toBe(404);
  });

  it('folds a kickback and counts the runs of the step it went back to', async () => {
    let reviews = 0;
    const result = await run(dag({
      name: 'returned',
      maxKickbacks: 1,
      nodes: {
        implement: fnJob('implement', () => 'wrote it'),
        review: {
          needs: 'implement',
          job: fnJob('review', (): Outcome => (reviews++ === 0 ? kickback('implement', 'missing header') : { status: 'pass', summary: 'fine' })),
        },
      },
    }), { monitor: true });
    opened.push(result);
    const state = JSON.parse((await get(`${result.monitor!.url}state`)).body) as { kickbacks: Array<{ from: string; to: string; accepted: boolean }>; nodes: Record<string, { runs: number }> };
    expect(state.kickbacks).toEqual([expect.objectContaining({ from: 'review', to: 'implement', accepted: true })]);
    expect(state.nodes.implement!.runs).toBe(2);
  });

  it('refuses to be framed by any origin, on the page and on the state', async () => {
    const result = await run(fnJob('a', () => {}), { monitor: true });
    opened.push(result);
    for (const path of ['', 'state']) {
      const res = await fetch(`${result.monitor!.url}${path}`);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    }
    const page = (await get(result.monitor!.url)).body;
    expect(page).not.toContain('onclick=');
  });

  it('closes on request, and the port is released', async () => {
    const result = await run(fnJob('a', () => {}), { monitor: true });
    const url = result.monitor!.url;
    expect((await get(`${url}state`)).status).toBe(200);
    await result.monitor!.close();
    await expect(fetch(`${url}state`)).rejects.toThrow();
  });
});
