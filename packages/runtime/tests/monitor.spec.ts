import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { agentJob, approval, createCallbackClient, createCallbackGate, dag, fnJob, formatEvent, humanReview, judge, kickback, pipeline, revisionRequest, run } from '../src/api.ts';
import type { JsonObject, LoopEvent, MonitorState, Outcome, RunResult } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';

type MonitorEvent = Extract<LoopEvent, { kind: 'monitor' }>;
const monitorEvents = (events: LoopEvent[]): MonitorEvent[] =>
  events.filter((e): e is MonitorEvent => e.kind === 'monitor');

const get = async (url: string) => {
  const res = await fetch(url);
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() };
};

/**
 * An element of the served page: its own markup, plus the cards the script
 * adds to its end one at a time, each of which the script can remove.
 */
function fakeElement(hidden: boolean, listen: (type: string, listener: (event: unknown) => void) => void) {
  let own = '';
  type Card = { html: string; getAttribute(name: string): string | null; remove(): void };
  const cards: Card[] = [];
  return {
    textContent: '', hidden,
    get innerHTML() { return own + cards.map((card) => card.html).join(''); },
    set innerHTML(html: string) { own = html; cards.length = 0; },
    get children() { return [...cards]; },
    insertAdjacentHTML(position: string, html: string) {
      if (position !== 'beforeend') throw new Error(`the page inserted at ${position}`);
      const card: Card = {
        html,
        getAttribute: (name) => new RegExp(`^<[^>]*\\b${name}="([^"]*)"`).exec(card.html)?.[1] ?? null,
        remove: () => { cards.splice(cards.indexOf(card), 1); },
      };
      cards.push(card);
    },
    addEventListener: listen,
    /** Put `html` just before a question's first button, wherever the script wrote that question's form. */
    typeInto(requestId: string, html: string) {
      const at = `data-request="${requestId}"`;
      const card = cards.find((c) => c.html.includes(at));
      if (card) card.html = card.html.replace(at, `${html}${at}`);
      else if (own.includes(at)) own = own.replace(at, `${html}${at}`);
      else throw new Error(`no form for ${requestId}`);
    },
  };
}

/** Host the served script's text writes and polling; layout and clicks need a browser. */
async function loadMonitorPage(url: string) {
  const page = await get(url);
  expect(page.status).toBe(200);
  const script = page.body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (script === undefined) throw new Error('the served monitor page has no script');
  // Only IDs present in the served markup exist. No renderer or usage text is supplied here.
  const markup = page.body.slice(0, page.body.indexOf('<script>'));
  const listeners = new Map<string, (event: unknown) => void>();
  const elements = new Map(Array.from(markup.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g), ([tag, id]) => [
    id!,
    fakeElement(/\bhidden(?:\s|>|=)/.test(tag), (type, listener) => listeners.set(`${id}:${type}`, listener)),
  ] as const));
  const posted: string[] = [];
  let answered: Promise<unknown> | undefined;
  let nextPoll: (() => Promise<void>) | undefined;
  let markReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { markReady = resolve; rejectReady = reject; });
  runInNewContext(script, {
    document: { getElementById: (id: string) => elements.get(id) ?? null },
    // Resolve browser-relative URLs, keeping the real response and JSON body unchanged.
    fetch: (path: string, init?: RequestInit) => {
      const response = fetch(new URL(path, url), init).catch((error) => {
        rejectReady(error);
        throw error;
      });
      // A finished or paused run's first render never calls `setTimeout` (it
      // has nothing left to poll for), so that alone can't be "ready" here: a
      // person opening the link after the run has already stopped is exactly
      // the case a review approval needs to render for. Two `setImmediate`
      // turns land after every microtask the script's own `await`s (the
      // fetch, then its `.json()`) can still have queued, so by then its
      // synchronous DOM writes are done either way.
      // The rejection itself is already routed to `rejectReady` above; this
      // chain only needs to stay quiet about it, not handle it again.
      if (path === 'state') response.then(() => setImmediate(() => setImmediate(markReady)), () => {});
      if (path === 'answer') { posted.push(String(init?.body)); answered = response; }
      return response;
    },
    setTimeout(callback: () => Promise<void>) {
      nextPoll = callback;
      markReady();
      return 1;
    },
  });
  await ready;
  return {
    text: (id: string) => elements.get(id)?.textContent ?? '',
    // Some panels (the record, the pending card) are set via innerHTML rather
    // than textContent, so a check on their markup needs the raw HTML.
    html: (id: string) => elements.get(id)?.innerHTML ?? '',
    visibleText: () => [...elements.values()].filter((element) => !element.hidden)
      .map((element) => element.textContent).join('\n'),
    /** Stand in for a person's typing into a pending question's form, so a check can see whether a poll rewrites it. */
    type(requestId: string, html: string) { elements.get('pending')!.typeInto(requestId, html); },
    /**
     * Click a button in a pending question's form, with `fields` as what the
     * person typed into the form's named fields, and return the body the
     * page posted once the page has read the answer. `choice` is the
     * option a person picked from the form's list of answer shapes, if any.
     */
    async click(requestId: string, fields: Record<string, string>, answer?: 'yes' | 'no', choice?: string) {
      const form = {
        elements: { namedItem: (name: string) => (name in fields ? { value: fields[name] } : null) },
        querySelector: (selector: string) => (selector === 'select[data-choice]' && choice !== undefined ? { value: choice } : null),
      };
      const button = {
        getAttribute: (name: string) => (name === 'data-request' ? requestId : name === 'data-answer' ? answer ?? null : null),
        closest: (selector: string) => (selector === 'form' ? form : null),
      };
      const before = posted.length;
      listeners.get('pending:click')!({ target: { closest: (selector: string) => (selector.startsWith('button') ? button : null) } });
      if (posted.length === before) throw new Error('the page posted no answer');
      await answered;
      await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
      return JSON.parse(posted.at(-1)!) as { requestId: string; response: JsonObject };
    },
    async poll() {
      const callback = nextPoll;
      nextPoll = undefined;
      if (callback === undefined) throw new Error('the served script did not schedule another poll');
      await callback();
    },
  };
}

/** Wait for `read` to give a value, checking every 20ms for up to five seconds. */
async function until<T>(read: () => T | undefined | Promise<T | undefined>): Promise<T> {
  for (let tries = 0; tries < 250; tries += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('gave up waiting');
}

/**
 * A page and a review that always sends it back, with a judge that asks a
 * person for a product decision after the first review and lets the work
 * stand after the next. `prompts` collects what the writer is asked.
 */
function productDecisionReview(prompts: string[]) {
  let judged = 0;
  const judgeEngine = new MockEngine(() => JSON.stringify({ stop_reason: { choice: judged++ === 0 ? 'product_decision' : 'holds' } }));
  return dag({
    name: 'product-review',
    maxKickbacks: { write: judge({ engine: judgeEngine, identity: { adapter: 'mock', provider: 'mock', modelFamily: 'judge-mock', model: 'judge-mock', tools: [] } }) },
    nodes: {
      write: agentJob({
        label: 'write', model: 'writer-mock', prompt: 'Write the page.', consumeFeedback: true,
        engine: new MockEngine((request) => { prompts.push(request.prompt); return 'wrote the page'; }),
      }),
      review: { needs: ['write'], job: fnJob('review', () => revisionRequest({
        target: 'write', reason: 'Choose the audience', findings: [{ severity: 'should-fix', evidence: 'The page must choose one audience.' }],
      })) },
    },
  });
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
    const state = JSON.parse((await get(`${result.monitor!.url}state`)).body) as MonitorState & { nodes: Record<string, { runs: number }> };
    expect(state.kickbacks).toEqual([expect.objectContaining({ from: 'review', to: 'implement', accepted: true })]);
    expect(state.nodes.implement!.runs).toBe(2);
    // The record panel carries the same kickback as one line with its reason,
    // and only one: the DAG emits a `dag:kickback` event exactly once per
    // occurrence, so nothing here folds it into two lines for one event.
    const kickbackLines = state.events.filter((e) => e.line.includes('kickback'));
    expect(kickbackLines).toHaveLength(1);
    expect(kickbackLines[0]!.line).toContain('missing header');
    expect(kickbackLines[0]!.line.includes('\n')).toBe(false);
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

  it('keeps only the field the record panel\'s line needs, in the console\'s own words, and drops a row with nothing to say', async () => {
    const events: LoopEvent[] = [];
    const result = await run(fnJob('chat', (ctx) => {
      ctx.emit({ kind: 'engine:tool', ts: 10, path: [], name: 'Read', phase: 'use' });
      ctx.emit({ kind: 'engine:text', ts: 11, path: [], delta: 'hello there' });
      ctx.emit({ kind: 'engine:thinking', ts: 12, path: [], delta: '' });
      ctx.emit({ kind: 'engine:thinking', ts: 13, path: [], delta: 'weighing it' });
      return 'done';
    }), { cwd: home, monitor: true, onEvent: (e) => events.push(e) });
    opened.push(result);
    const state: MonitorState = JSON.parse((await get(`${monitorEvents(events)[0]!.url}state`)).body);
    // Exactly the fields the display uses: a timestamp and the line, nothing
    // it would have to keep re-deriving into its own separate rendering.
    for (const row of state.events) expect(Object.keys(row).sort()).toEqual(['line', 'ts']);
    const lines = state.events.map((row) => row.line);
    expect(lines).toContain(formatEvent({ kind: 'engine:tool', ts: 10, path: [], name: 'Read', phase: 'use' }));
    // Streamed text and thinking chunks never become rows: a person reads the step's summary instead.
    expect(lines.some((line) => line.includes('hello there') || line.includes('weighing it'))).toBe(false);
    expect(lines.some((line) => line.trim() === 'engine:thinking' || line === '')).toBe(false);
  });

  it('shows the approval question\'s input, and links to it when the input carries a url', async () => {
    const client = createCallbackClient();
    const result = await run(
      approval('approve', {
        question: 'Ship this?',
        input: { file: 'src/index.ts', sha: 'abc123', url: 'https://example.invalid/pr/1' },
      }),
      { monitor: true, callbacks: client },
    );
    opened.push(result);
    expect(result.outcome.status).toBe('paused');
    const page = await loadMonitorPage(result.monitor!.url);
    const pendingHtml = page.html('pending');
    expect(pendingHtml).toContain('src/index.ts');
    expect(pendingHtml).toContain('abc123');
    expect(pendingHtml).toContain('<a href="https://example.invalid/pr/1"');
    // The input and its link read before a person reaches the yes/no
    // buttons, never after: a reviewer sees what they're approving first.
    expect(pendingHtml.indexOf('src/index.ts')).toBeLessThan(pendingHtml.indexOf('<form'));
    expect(pendingHtml.indexOf('<a href="https://example.invalid/pr/1"')).toBeLessThan(pendingHtml.indexOf('<form'));
  });
  it('sends each question\'s response schema in /state', async () => {
    const client = createCallbackClient();
    const result = await run(approval('approve', { question: 'Ship?', input: { change: 'abc' } }), { monitor: true, callbacks: client });
    opened.push(result);
    const state: MonitorState = JSON.parse((await get(`${result.monitor!.url}state`)).body);
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0]!.responseSchema).toEqual(client.listPending()[0]!.responseSchema);
    expect(state.pending[0]!.responseSchema.required).toEqual(['approved']);
  });

  it('lets a person answer a judge\'s product decision with a written decision, and the run goes on with it', async () => {
    const events: LoopEvent[] = [];
    const prompts: string[] = [];
    const running = run(productDecisionReview(prompts), { cwd: home, monitor: true, onCallback: 'wait', onEvent: (e) => events.push(e) });
    const url = await until(() => monitorEvents(events)[0]?.url);
    const pending = await until(async () => {
      const state: MonitorState = JSON.parse((await get(`${url}state`)).body);
      return state.pending[0];
    });
    expect(pending.decisionText).toBe('What product decision should guide this review?');
    expect(pending.responseSchema.required).toEqual(expect.arrayContaining(['prompt', 'feedback']));
    const page = await loadMonitorPage(url);
    const card = page.html('pending');
    expect(card).toContain('<textarea name="prompt"');
    expect(card).not.toContain('data-answer="yes"');
    // A poll while the question still waits leaves the card, and what a person typed into it, alone.
    page.type(pending.requestId, '<!-- typed -->');
    await page.poll();
    expect(page.html('pending')).toContain('<!-- typed -->');
    // A blank decision is refused, and the reason and the form both outlast the next poll.
    await page.click(pending.requestId, { prompt: '   ' });
    expect(page.text('status')).toMatch(/^the answer was refused: /);
    await page.poll();
    expect(page.text('status')).toMatch(/^the answer was refused: /);
    expect(page.html('pending')).toContain('<!-- typed -->');
    const body = await page.click(pending.requestId, { prompt: 'Write for new users.' });
    expect(body).toEqual({ requestId: pending.requestId, response: { prompt: 'Write for new users.', feedback: {} } });
    expect(page.text('status')).toBe('answered');
    const result = await running;
    opened.push(result);
    expect(result.outcome.status, result.outcome.summary).toBe('pass');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Write for new users.');
  });

  it('shows any other schema\'s required fields as labelled inputs and posts what a person typed', async () => {
    const client = createCallbackClient();
    const result = await run(fnJob('a', () => {}), { monitor: true, callbacks: client });
    opened.push(result);
    const request = createCallbackGate({
      gateId: 'ticket', gateVersion: 1, decisionText: 'Which ticket, and how many people?', input: null,
      responseSchema: { type: 'object', properties: { ticket: { type: 'string' }, people: { type: 'integer' } }, required: ['ticket', 'people'] },
    });
    await client.post(request);
    const page = await loadMonitorPage(result.monitor!.url);
    const card = page.html('pending');
    expect(card).toMatch(/<label>ticket<input name="ticket"/);
    expect(card).toMatch(/<label>people<input name="people"/);
    const body = await page.click(request.requestId, { ticket: 'ABC-1', people: '3' });
    expect(body.response).toEqual({ ticket: 'ABC-1', people: 3 });
    expect(page.text('status')).toBe('answered');
    expect(client.listPending()).toHaveLength(0);
  });

  it('asks for the required fields a schema states inside allOf, with their types', async () => {
    const client = createCallbackClient();
    const result = await run(fnJob('a', () => {}), { monitor: true, callbacks: client });
    opened.push(result);
    const request = createCallbackGate({
      gateId: 'ticket', gateVersion: 1, decisionText: 'Which ticket, and how many people?', input: null,
      responseSchema: { allOf: [{ properties: { ticket: { type: 'string' } }, required: ['ticket'] }, { allOf: [{ properties: { people: { type: 'integer' } }, required: ['people'] }] }] },
    });
    await client.post(request);
    const page = await loadMonitorPage(result.monitor!.url);
    const card = page.html('pending');
    expect(card).toMatch(/<label>ticket<input name="ticket"/);
    expect(card).toMatch(/<label>people<input name="people"/);
    const body = await page.click(request.requestId, { ticket: 'ABC-1', people: '3' });
    expect(body.response).toEqual({ ticket: 'ABC-1', people: 3 });
    expect(page.text('status')).toBe('answered');
    expect(client.listPending()).toHaveLength(0);
  });

  it('lets a person pick one of the answer shapes a schema accepts and fill in its fields', async () => {
    const client = createCallbackClient();
    const result = await run(fnJob('a', () => {}), { monitor: true, callbacks: client });
    opened.push(result);
    const request = createCallbackGate({
      gateId: 'ticket-or-reason', gateVersion: 1, decisionText: 'Which ticket, or why is there none?', input: null,
      responseSchema: { type: 'object', properties: { ticket: { type: 'string' }, reason: { type: 'string' } }, anyOf: [{ required: ['ticket'] }, { required: ['reason'] }] },
    });
    await client.post(request);
    const page = await loadMonitorPage(result.monitor!.url);
    const card = page.html('pending');
    expect(card).toMatch(/<select data-choice><option value="0">ticket<\/option><option value="1">reason<\/option><\/select>/);
    expect(card).toMatch(/<label>ticket<input name="ticket"/);
    expect(card).toMatch(/<label>reason<input name="reason"/);
    const body = await page.click(request.requestId, { ticket: '', reason: 'No ticket yet.' }, undefined, '1');
    expect(body.response).toEqual({ reason: 'No ticket yet.' });
    expect(page.text('status')).toBe('answered');
    expect(client.listPending()).toHaveLength(0);
  });

  it('lets a person answer a human review whose own schema asks for one of two fields', async () => {
    const client = createCallbackClient();
    const result = await run(humanReview('ship', {
      question: 'Ship this?', input: { change: 'abc' },
      interaction: { id: 'ship', responseSchema: { type: 'object', properties: { ticket: { type: 'string' }, reason: { type: 'string' } }, anyOf: [{ required: ['ticket'] }, { required: ['reason'] }] } },
    }), { monitor: true, callbacks: client });
    opened.push(result);
    expect(result.outcome.status).toBe('paused');
    const page = await loadMonitorPage(result.monitor!.url);
    const card = page.html('pending');
    expect(card).toContain('<option value="0">decision: approved; ticket</option>');
    expect(card).toMatch(/<label>ticket<input name="ticket"/);
    expect(card).toMatch(/<label>reason<input name="reason"/);
    const requestId = client.listPending()[0]!.requestId;
    const body = await page.click(requestId, { ticket: 'ABC-1' }, undefined, '0');
    expect(body.response).toEqual({ ticket: 'ABC-1', feedback: {}, prompt: '', decision: 'approved' });
    expect(page.text('status')).toBe('answered');
    expect(client.listPending()).toHaveLength(0);
  });

  it('keeps what a person typed into one question while another question arrives or goes', async () => {
    const client = createCallbackClient();
    const events: LoopEvent[] = [];
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const running = run(fnJob('a', () => held), { monitor: true, callbacks: client, onEvent: (e) => events.push(e) });
    const url = await until(() => monitorEvents(events)[0]?.url);
    const ask = async (gateId: string) => {
      const request = createCallbackGate({
        gateId, gateVersion: 1, decisionText: `Which ${gateId}?`, input: null,
        responseSchema: { type: 'object', properties: { ticket: { type: 'string' } }, required: ['ticket'] },
      });
      await client.post(request);
      return request;
    };
    const first = await ask('first');
    const second = await ask('second');
    const page = await loadMonitorPage(url);
    page.type(first.requestId, '<!-- typed -->');
    const third = await ask('third');
    await page.poll();
    expect(page.html('pending')).toContain('<!-- typed -->');
    expect(page.html('pending')).toContain(`data-request="${third.requestId}"`);
    const claim = await client.claim(second.requestId, 'someone else');
    if (!claim.ok) throw new Error(claim.kind);
    expect((await client.submit(second.requestId, claim.claimToken, 'someone else', second.digest, { ticket: 'B' })).ok).toBe(true);
    await page.poll();
    expect(page.html('pending')).toContain('<!-- typed -->');
    expect(page.html('pending')).not.toContain(`data-request="${second.requestId}"`);
    expect(page.html('pending').indexOf('<!-- typed -->')).toBeLessThan(page.html('pending').indexOf(`data-request="${third.requestId}"`));
    finish();
    opened.push(await running);
  });

  it('fills a decision\'s feedback with the empty value its schema accepts', async () => {
    const client = createCallbackClient();
    const result = await run(fnJob('a', () => {}), { monitor: true, callbacks: client });
    opened.push(result);
    const request = createCallbackGate({
      gateId: 'decide', gateVersion: 1, decisionText: 'Which audience?', input: null,
      responseSchema: { type: 'object', properties: { prompt: { type: 'string' }, feedback: { type: 'string' } }, required: ['feedback', 'prompt'] },
    });
    await client.post(request);
    const page = await loadMonitorPage(result.monitor!.url);
    expect(page.html('pending')).not.toContain('name="feedback"');
    const body = await page.click(request.requestId, { prompt: 'New users.' });
    expect(body.response).toEqual({ prompt: 'New users.', feedback: '' });
    expect(page.text('status')).toBe('answered');
  });

  it('asks a person for a decision\'s feedback when its schema allows only some values', async () => {
    const client = createCallbackClient();
    const result = await run(fnJob('a', () => {}), { monitor: true, callbacks: client });
    opened.push(result);
    const request = createCallbackGate({
      gateId: 'decide', gateVersion: 1, decisionText: 'Which audience?', input: null,
      responseSchema: { type: 'object', properties: { prompt: { type: 'string' }, feedback: { type: 'string', enum: ['accept', 'revise'] } }, required: ['feedback', 'prompt'] },
    });
    await client.post(request);
    const page = await loadMonitorPage(result.monitor!.url);
    expect(page.html('pending')).toMatch(/<label>feedback<input name="feedback" placeholder="one of: accept, revise"/);
    const body = await page.click(request.requestId, { prompt: 'New users.', feedback: 'revise' });
    expect(body.response).toEqual({ prompt: 'New users.', feedback: 'revise' });
    expect(page.text('status')).toBe('answered');
    expect(client.listPending()).toHaveLength(0);
  });

  it('answers an approval with its yes and the note a person wrote', async () => {
    const client = createCallbackClient();
    const result = await run(approval('approve', { question: 'Ship?', input: { change: 'abc' } }), { monitor: true, callbacks: client });
    opened.push(result);
    const page = await loadMonitorPage(result.monitor!.url);
    expect(page.html('pending')).not.toContain('<textarea');
    const requestId = client.listPending()[0]!.requestId;
    const body = await page.click(requestId, { note: 'looks right' }, 'yes');
    expect(body.response).toEqual({ approved: true, note: 'looks right' });
    expect(page.text('status')).toBe('answered');
  });
});
