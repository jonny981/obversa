/**
 * The run monitor: one page per run, served from the runtime itself with no
 * build step and no framework. It binds a free port on the loopback address,
 * folds the run's own event stream into the state of each declared node, and
 * serves that state as JSON and as a page that polls it. Its only control is
 * answering a pending question through the run's callbacks client, which is
 * what a callback router may do already; nothing on the page starts, stops or
 * edits a run. The server does not keep the process alive: a script ends
 * when its run ends, and the page lives as long as the process does.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import type { CallbackRequest } from '../callback/gate.js';
import { jobMeta } from '../core/describe.js';
import type { JsonObject, JsonValue } from '../graph/value.js';
import type { Job, JobMeta, LoopEvent, Outcome, RunCallbacks } from '../core/types.js';

export interface RunMonitor {
  /** The page's address: `http://127.0.0.1:<port>/`. */
  readonly url: string;
  /** Stop serving and release the port. */
  close(): Promise<void>;
}

export type MonitorNodePhase = 'declared' | 'running' | 'done' | 'skipped';

export interface MonitorNodeState {
  phase: MonitorNodePhase;
  needs: string[];
  desc?: string;
  gate?: string;
  optional?: boolean;
  /** How many times the node has started in this run. */
  runs: number;
  outcome?: { status: Outcome['status']; summary?: string };
}

export interface MonitorKickback {
  from: string;
  to: string;
  reason: string;
  accepted: boolean;
  count: number;
  limit: number;
  note?: string;
}

export interface MonitorState {
  runId?: string;
  name?: string;
  status: 'running' | 'done';
  outcome?: { status: Outcome['status']; summary?: string };
  nodes: Record<string, MonitorNodeState>;
  kickbacks: MonitorKickback[];
  pending: Array<{ requestId: string; decisionText: string; input: JsonValue }>;
  events: Array<{ kind: string; ts: number; path: string[]; node?: string; label?: string; summary?: string }>;
}

const EVENT_TAIL = 200;

interface DeclaredNode {
  name: string;
  needs?: string[];
  desc?: string;
  gate?: string;
  optional?: boolean;
}

/** The nodes a job declares, read from its meta; a bare job declares none. */
function declaredNodes(meta: JobMeta | undefined): DeclaredNode[] {
  if (!meta || meta.kind !== 'dag' || !Array.isArray(meta.nodes)) return [];
  return (meta.nodes as DeclaredNode[]).filter((n) => typeof n?.name === 'string');
}

function outcomeLine(outcome: Outcome | undefined): MonitorNodeState['outcome'] {
  if (!outcome) return undefined;
  return outcome.summary === undefined ? { status: outcome.status } : { status: outcome.status, summary: outcome.summary };
}

class MonitorFold {
  readonly nodes: Record<string, MonitorNodeState> = {};
  readonly kickbacks: MonitorKickback[] = [];
  readonly events: MonitorState['events'] = [];
  status: MonitorState['status'] = 'running';
  outcome?: MonitorState['outcome'];
  readonly name?: string;

  constructor(job: Job) {
    const meta = jobMeta(job);
    this.name = typeof meta?.name === 'string' ? meta.name : undefined;
    for (const node of declaredNodes(meta)) {
      this.nodes[node.name] = {
        phase: 'declared',
        needs: node.needs ?? [],
        ...(node.desc !== undefined ? { desc: node.desc } : {}),
        ...(node.gate !== undefined ? { gate: node.gate } : {}),
        ...(node.optional ? { optional: true } : {}),
        runs: 0,
      };
    }
  }

  apply(event: LoopEvent): void {
    // Only the root dag's nodes are the page's nodes; a nested dag's are its
    // own step's business and show through that step's outcome.
    if (event.kind === 'dag:node' && event.path.length <= 1) {
      const node = this.nodes[event.node] ?? (this.nodes[event.node] = { phase: 'declared', needs: event.needs ?? [], runs: 0 });
      if (event.needs) node.needs = event.needs;
      if (event.desc !== undefined) node.desc = event.desc;
      if (event.gate !== undefined) node.gate = event.gate;
      if (event.phase === 'start') { node.phase = 'running'; node.runs += 1; delete node.outcome; }
      if (event.phase === 'skip') { node.phase = 'skipped'; node.outcome = outcomeLine(event.outcome); }
      if (event.phase === 'done') { node.phase = 'done'; node.outcome = outcomeLine(event.outcome); }
    }
    if (event.kind === 'dag:kickback' && event.path.length <= 1) {
      this.kickbacks.push({
        from: event.from, to: event.to, reason: event.reason, accepted: event.accepted,
        count: event.count, limit: event.limit, ...(event.note !== undefined ? { note: event.note } : {}),
      });
    }
    const line: MonitorState['events'][number] = { kind: event.kind, ts: event.ts, path: [...event.path] };
    if ('node' in event && typeof event.node === 'string') line.node = event.node;
    if ('label' in event && typeof event.label === 'string') line.label = event.label;
    if ('outcome' in event && event.outcome && typeof event.outcome === 'object' && 'summary' in event.outcome && typeof event.outcome.summary === 'string') {
      line.summary = event.outcome.summary;
    }
    this.events.push(line);
    if (this.events.length > EVENT_TAIL) this.events.splice(0, this.events.length - EVENT_TAIL);
  }

  finish(outcome: Outcome): void {
    this.status = 'done';
    this.outcome = outcomeLine(outcome);
  }
}

async function pendingOf(client: RunCallbacks): Promise<MonitorState['pending']> {
  const pending = await client.listPending();
  return pending.map((request) => ({ requestId: request.requestId, decisionText: request.decisionText, input: request.input }));
}

const BODY_LIMIT = 64 * 1024;

class BodyError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** The body as JSON, bounded, or a status the handler answers with. */
async function readJson(req: IncomingMessage): Promise<JsonValue> {
  const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') throw new BodyError(415, 'the body must be application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw new BodyError(413, 'the body is too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? (JSON.parse(text) as JsonValue) : null;
  } catch {
    throw new BodyError(400, 'the body is not valid JSON');
  }
}

/**
 * Only the page's own browser tab may read or write: the Host must be the
 * bound loopback address (a rebound DNS name is refused), and a write must
 * come from our own origin or from no origin at all (a script), never from
 * another site's page.
 */
function ownPage(req: IncomingMessage, host: string): boolean {
  if (req.headers.host !== host) return false;
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== `http://${host}`) return false;
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
  return true;
}

function send(res: ServerResponse, status: number, body: string, type: string): void {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

const json = (res: ServerResponse, status: number, value: unknown): void => send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');

/** Answer one pending question as the page's router, through the same client any router uses. */
async function answer(client: RunCallbacks, body: JsonValue): Promise<{ status: number; result: JsonObject }> {
  const asked = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as JsonObject) : undefined;
  if (asked === undefined || typeof asked.requestId !== 'string') {
    return { status: 400, result: { ok: false, reason: 'the body needs a requestId and a response' } };
  }
  const request = (await client.listPending()).find((r: CallbackRequest) => r.requestId === asked.requestId);
  if (!request) return { status: 404, result: { ok: false, reason: 'no pending question has that requestId' } };
  const claim = await client.claim(request.requestId, 'monitor');
  if (!claim.ok) return { status: 409, result: { ok: false, reason: `the question could not be claimed: ${claim.kind}` } };
  try {
    const submitted = await client.submit(request.requestId, claim.claimToken, 'monitor', request.digest, asked.response ?? null);
    if (!submitted.ok) {
      await client.release(request.requestId, claim.claimToken);
      return { status: 400, result: { ok: false, kind: submitted.kind, reason: submitted.reason } };
    }
    return { status: 200, result: { ok: true, response: submitted.response } };
  } catch (error) {
    await client.release(request.requestId, claim.claimToken);
    return { status: 400, result: { ok: false, reason: error instanceof Error ? error.message : String(error) } };
  }
}

export interface StartedMonitor {
  monitor: RunMonitor;
  sink: (event: LoopEvent) => void;
  finish: (outcome: Outcome) => void;
}

/** Bind the page to a free loopback port and return its address, sink and finish hook. */
export async function startMonitor(opts: { job: Job; callbacks: RunCallbacks; runId?: string }): Promise<StartedMonitor> {
  const fold = new MonitorFold(opts.job);
  const state = async (): Promise<MonitorState> => ({
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    ...(fold.name !== undefined ? { name: fold.name } : {}),
    status: fold.status,
    ...(fold.outcome !== undefined ? { outcome: fold.outcome } : {}),
    nodes: fold.nodes,
    kickbacks: fold.kickbacks,
    pending: await pendingOf(opts.callbacks),
    events: fold.events,
  });

  let host = '';
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0];
      try {
        if (!ownPage(req, host)) return send(res, 403, 'not this page', 'text/plain');
        if (path === '/' || path === '/index.html') {
          if (req.method !== 'GET') return send(res, 405, 'method not allowed', 'text/plain');
          return send(res, 200, page(fold.name), 'text/html; charset=utf-8');
        }
        if (path === '/state') {
          if (req.method !== 'GET') return send(res, 405, 'method not allowed', 'text/plain');
          return json(res, 200, await state());
        }
        if (path === '/answer') {
          if (req.method !== 'POST') return send(res, 405, 'method not allowed', 'text/plain');
          const { status, result } = await answer(opts.callbacks, await readJson(req));
          return json(res, status, result);
        }
        return send(res, 404, 'not found', 'text/plain');
      } catch (error) {
        if (error instanceof BodyError) return json(res, error.status, { ok: false, reason: error.message });
        return json(res, 500, { ok: false, reason: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  server.unref();
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  host = `127.0.0.1:${port}`;
  const url = `http://${host}/`;
  let closed: Promise<void> | undefined;
  const monitor: RunMonitor = {
    url,
    close: () => {
      closed ??= new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      });
      return closed;
    },
  };
  return { monitor, sink: (event) => fold.apply(event), finish: (outcome) => fold.finish(outcome) };
}

/** The page: the declared graph, each node's live state, the returns, the pending questions and the record tail, polled once a second. */
function page(name: string | undefined): string {
  const title = name ? `${name}, running` : 'a run';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; --bg: #0E1F15; --panel: #142A1C; --ink: #E8F3E9; --muted: #9EC8AA; --line: #2F5A3F; --mark: #73E2A7; --back: #E0A458; --fail: #E07A7A; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 "Helvetica Neue", Arial, sans-serif; }
  main { max-width: 64rem; margin: 0 auto; padding: 1.5rem clamp(1rem, 4vw, 3rem) 3rem; }
  h1 { font-size: 1.3rem; margin: 0 0 .25rem; } h2 { font-size: 1rem; margin: 2rem 0 .5rem; color: var(--muted); font-weight: 500; }
  .status { font-family: ui-monospace, Menlo, monospace; color: var(--muted); font-size: .9rem; }
  ol.nodes { list-style: none; margin: 1rem 0 0; padding: 0; border-top: 1px solid var(--line); }
  ol.nodes li { display: grid; grid-template-columns: 9rem minmax(0, 1fr) 8rem; gap: 1rem; padding: .7rem 0; border-bottom: 1px solid var(--line); align-items: baseline; }
  .name { font-weight: 700; } .needs, .desc, .summary { color: var(--muted); font-size: .9rem; }
  .phase { font-family: ui-monospace, Menlo, monospace; font-size: .85rem; text-align: right; }
  .phase[data-phase="running"] { color: var(--mark); } .phase[data-phase="done"][data-status="fail"] { color: var(--fail); }
  .phase[data-phase="skipped"], .phase[data-phase="declared"] { color: var(--muted); }
  .kick { color: var(--back); font-size: .9rem; }
  form { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin-top: .5rem; }
  button { font: inherit; padding: .4rem .8rem; border-radius: 4px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); cursor: pointer; }
  button.yes { background: var(--mark); color: #071209; border-color: var(--mark); }
  input { font: inherit; padding: .4rem .6rem; border-radius: 4px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); min-width: 18rem; }
  pre { font: .8rem/1.5 ui-monospace, Menlo, monospace; color: var(--muted); background: var(--panel); padding: .8rem 1rem; border-radius: 4px; overflow-x: auto; max-height: 20rem; }
  @media (max-width: 640px) { ol.nodes li { grid-template-columns: 1fr; gap: .2rem; } .phase { text-align: left; } }
</style>
</head>
<body>
<main>
  <h1 id="title">${escapeHtml(title)}</h1>
  <p class="status" id="status">connecting</p>
  <ol class="nodes" id="nodes"></ol>
  <div id="kickbacks"></div>
  <h2 id="pending-title" hidden>Waiting for a person</h2>
  <div id="pending"></div>
  <h2>The record</h2>
  <pre id="record"></pre>
</main>
<script>
(() => {
  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  async function answer(requestId, approved) {
    const note = (el('note-' + requestId) || {}).value || '';
    const response = note ? { approved, note } : { approved };
    await fetch('answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId, response }) });
    render();
  }
  window.answer = answer;
  async function render() {
    let s;
    try { s = await (await fetch('state', { cache: 'no-store' })).json(); } catch { el('status').textContent = 'the run has gone'; return; }
    el('title').textContent = (s.name || 'a run') + (s.status === 'done' ? ', ' + (s.outcome ? s.outcome.status : 'done') : ', running');
    el('status').textContent = s.status === 'done' ? (s.outcome && s.outcome.summary ? s.outcome.summary : 'finished') : 'running' + (s.runId ? ' · ' + s.runId : '');
    const names = Object.keys(s.nodes);
    el('nodes').innerHTML = names.map((n) => { const v = s.nodes[n]; return '<li><span class="name">' + esc(n) + (v.runs > 1 ? ' <span class="desc">ran ' + v.runs + ' times</span>' : '') + '</span>'
      + '<span>' + (v.desc ? '<div class="desc">' + esc(v.desc) + '</div>' : '') + (v.needs && v.needs.length ? '<div class="needs">needs ' + esc(v.needs.join(', ')) + '</div>' : '') + (v.outcome && v.outcome.summary ? '<div class="summary">' + esc(v.outcome.summary) + '</div>' : '') + '</span>'
      + '<span class="phase" data-phase="' + esc(v.phase) + '" data-status="' + esc(v.outcome ? v.outcome.status : '') + '">' + esc(v.phase === 'done' && v.outcome ? v.outcome.status : v.phase) + '</span></li>'; }).join('');
    el('kickbacks').innerHTML = s.kickbacks.map((k) => '<p class="kick">' + esc(k.from) + ' sent work back to ' + esc(k.to) + (k.accepted ? '' : ' (not accepted' + (k.note ? ': ' + esc(k.note) : '') + ')') + ': ' + esc(k.reason) + ' (' + k.count + ' of ' + k.limit + ')</p>').join('');
    el('pending-title').hidden = s.pending.length === 0;
    el('pending').innerHTML = s.pending.map((p) => '<div><p>' + esc(p.decisionText) + '</p><form onsubmit="return false"><input id="note-' + esc(p.requestId) + '" placeholder="a note, if any"><button class="yes" onclick="answer(' + JSON.stringify(p.requestId).replace(/"/g, '&quot;') + ', true)">Yes</button><button onclick="answer(' + JSON.stringify(p.requestId).replace(/"/g, '&quot;') + ', false)">No</button></form></div>').join('');
    el('record').textContent = s.events.slice(-40).map((e) => new Date(e.ts).toISOString().slice(11, 19) + '  ' + e.kind.padEnd(14) + (e.node || e.label || '') + (e.summary ? '  ' + e.summary : '')).join('\\n');
    if (s.status !== 'done') setTimeout(render, 1000);
  }
  render();
})();
</script>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}
