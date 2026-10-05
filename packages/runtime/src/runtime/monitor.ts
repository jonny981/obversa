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
import type { Job, JobMeta, LoopEvent, Outcome, RunCallbacks, UsageTotals } from '../core/types.js';
import { formatEvent, runningTotal } from './supervisor.js';

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
  limit?: number;
  note?: string;
}

export interface MonitorState {
  runId?: string;
  name?: string;
  status: 'running' | 'done';
  outcome?: { status: Outcome['status']; summary?: string };
  nodes: Record<string, MonitorNodeState>;
  kickbacks: MonitorKickback[];
  /** What the run has spent so far, the same shape the line formatter takes. */
  usage: UsageTotals;
  /** The same spend as one line of text, already formatted; `/state` sends it. */
  usageSummary: string;
  /** Each waiting question, with the response schema an answer to it must match. */
  pending: Array<{ requestId: string; decisionText: string; input: JsonValue; responseSchema: JsonObject }>;
  /**
   * The record, already in the one line `formatEvent` would print for it: the
   * console and this page must never disagree about what an event says, so
   * neither keeps its own partial fields to re-render from. An event with
   * nothing worth telling a person (thinking with no text yet) contributes no
   * line at all, rather than a row that says only its own kind.
   */
  events: Array<{ ts: number; line: string }>;
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
  readonly usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, unmeasuredCalls: 0 };
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
    if (event.kind === 'run:end') {
      this.status = 'done';
      this.outcome = outcomeLine(event.outcome);
    }
    if (event.kind === 'engine:usage') {
      if (event.usage.kind === 'unknown') this.usage.unmeasuredCalls += 1;
      else {
        this.usage.inputTokens += event.usage.inputTokens;
        this.usage.outputTokens += event.usage.outputTokens;
        this.usage.cacheReadInputTokens += event.usage.cacheReadInputTokens ?? 0;
        this.usage.cacheCreationInputTokens += event.usage.cacheCreationInputTokens ?? 0;
      }
    }
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
        count: event.count, ...(event.limit !== undefined ? { limit: event.limit } : {}), ...(event.note !== undefined ? { note: event.note } : {}),
      });
    }
    // Usage above is folded first, so a usage line's running total already
    // includes this call, the same way the console's tail totals do.
    const line = formatEvent(event, this.usage);
    if (line !== '') {
      this.events.push({ ts: event.ts, line });
      if (this.events.length > EVENT_TAIL) this.events.splice(0, this.events.length - EVENT_TAIL);
    }
  }

  finish(outcome: Outcome): void {
    this.status = 'done';
    this.outcome = outcomeLine(outcome);
  }
}

async function pendingOf(client: RunCallbacks): Promise<MonitorState['pending']> {
  const pending = await client.listPending();
  return pending.map((request) => ({ requestId: request.requestId, decisionText: request.decisionText, input: request.input, responseSchema: request.responseSchema }));
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
  // No page may frame this one: the answer buttons must be the person's own click on this tab.
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'content-security-policy': "frame-ancestors 'none'",
  });
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
    usage: fold.usage,
    usageSummary: runningTotal(fold.usage),
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
  input, textarea, select { font: inherit; padding: .4rem .6rem; border-radius: 4px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); min-width: 18rem; }
  form.fields { flex-direction: column; align-items: flex-start; } label { display: flex; flex-direction: column; gap: .25rem; color: var(--muted); }
  textarea { width: min(40rem, 80vw); }
  pre { font: .8rem/1.5 ui-monospace, Menlo, monospace; color: var(--muted); background: var(--panel); padding: .8rem 1rem; border-radius: 4px; overflow-x: auto; max-height: 20rem; }
  @media (max-width: 640px) { ol.nodes li { grid-template-columns: 1fr; gap: .2rem; } .phase { text-align: left; } }
</style>
</head>
<body>
<main>
  <h1 id="title">${escapeHtml(title)}</h1>
  <p class="status"><span id="status">connecting</span><span id="usage"></span></p>
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
  // What the question is about: the raw input, and a link when it names one,
  // so a reviewer can open the thing being approved instead of taking the
  // question's word for it.
  function aboutHtml(input) {
    if (input === null || input === undefined) return '';
    const url = input && typeof input === 'object' && !Array.isArray(input) && typeof input.url === 'string' ? input.url : null;
    const link = url ? '<p><a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(url) + '</a></p>' : '';
    return '<pre>' + esc(JSON.stringify(input, null, 2)) + '</pre>' + link;
  }
  // Each question says the shape of its answer. An approval (only approved
  // required) gets Yes and No; any other schema gets its required fields.
  // An answer must also match every allOf part, so their fields count too.
  function shapeOf(schema) {
    const shape = { required: [], properties: {} };
    if (!schema || typeof schema !== 'object') return shape;
    const parts = (Array.isArray(schema.allOf) ? schema.allOf.map(shapeOf) : []).concat({
      required: Array.isArray(schema.required) ? schema.required.filter((f) => typeof f === 'string') : [],
      properties: schema.properties && typeof schema.properties === 'object' ? schema.properties : {},
    });
    for (const part of parts) {
      for (const f of part.required) if (!shape.required.includes(f)) shape.required.push(f);
      for (const [f, rules] of Object.entries(part.properties)) shape.properties[f] = Object.assign({}, shape.properties[f], rules);
    }
    return shape;
  }
  // Every anyOf an answer must match: the schema's own, then those inside its allOf parts.
  function anyOfsOf(schema) {
    if (!schema || typeof schema !== 'object') return [];
    const own = (Array.isArray(schema.anyOf) ? schema.anyOf : []).filter((c) => c && typeof c === 'object' && !Array.isArray(c));
    return (own.length ? [own] : []).concat(Array.isArray(schema.allOf) ? schema.allOf.flatMap(anyOfsOf) : []);
  }
  // An answer must match one part of each anyOf, so a choice is one part from each,
  // and the schema it must match is then the whole schema with those parts.
  function choicesOf(schema) {
    const anyOfs = anyOfsOf(schema);
    return anyOfs.length ? anyOfs.reduce((picks, parts) => picks.flatMap((pick) => parts.map((part) => pick.concat([part]))), [[]]) : [];
  }
  const chosen = (schema, choice) => (choicesOf(schema)[choice] ? { allOf: [schema].concat(choicesOf(schema)[choice]) } : schema);
  // A part is named by its title, else by the fields it requires and the values it fixes.
  function partName(part) {
    if (typeof part.title === 'string') return part.title;
    const shape = shapeOf(part);
    const fixed = Object.entries(shape.properties).flatMap(([f, rules]) => { const one = oneValue(rules); return one ? [f + ': ' + (typeof one.value === 'string' ? one.value : JSON.stringify(one.value))] : []; });
    return shape.required.concat(fixed).join(', ');
  }
  const choiceName = (pick, index) => pick.map(partName).filter(Boolean).join('; ') || 'option ' + (index + 1);
  const oneValue = (rules) => (rules && 'const' in rules ? { value: rules.const } : rules && Array.isArray(rules.enum) && rules.enum.length === 1 ? { value: rules.enum[0] } : undefined);
  const requiredOf = (schema) => shapeOf(schema).required;
  const isApproval = (schema) => requiredOf(schema).join() === 'approved';
  const typesOf = (field) => (field && field.type !== undefined ? [].concat(field.type) : []);
  // A field is filled in when its schema allows one value. Otherwise the person types it.
  function filledFor(schema, field) {
    return oneValue(shapeOf(schema).properties[field]);
  }
  const asked = (schema) => requiredOf(schema).filter((f) => !filledFor(schema, f));
  // What a person typed, as the field's type. A blank untyped or object field, such as a judge's
  // default feedback, sends an empty object. Otherwise a string or untyped field sends the text,
  // and any other field, an object field included, sends the text parsed as JSON, or the text when it does not parse.
  function valueFor(field, text) {
    const types = typesOf(field);
    if (!text.trim() && (types.length === 0 || types.includes('object'))) return {};
    if (types.length === 0 || types.includes('string')) return text;
    try { return JSON.parse(text); } catch { return text; }
  }
  // The response a non-approval form posts; read(field) is the text typed into that field,
  // and choice is the anyOf part the person picked.
  function responseFor(original, read, choice) {
    const schema = chosen(original, choice);
    const properties = shapeOf(schema).properties;
    const response = {};
    for (const field of requiredOf(schema)) { const filled = filledFor(schema, field); response[field] = filled ? filled.value : valueFor(properties[field], read(field)); }
    return response;
  }
  // A field's label is its own description, when its schema gives one.
  const describe = (property, fallback) => (property && typeof property.description === 'string' ? property.description : fallback);
  function formHtml(p) {
    const id = esc(p.requestId);
    if (isApproval(p.responseSchema)) {
      const note = '<input name="note" placeholder="a note, if any">';
      const described = describe(shapeOf(p.responseSchema).properties.note);
      return '<form onsubmit="return false">' + (described === undefined ? note : '<label>' + esc(described) + note + '</label>') + '<button class="yes" data-answer="yes" data-request="' + id + '">Yes</button><button data-answer="no" data-request="' + id + '">No</button></form>';
    }
    // With a choice of shapes, the form shows every field any choice asks for, and sends the chosen one's.
    const choices = choicesOf(p.responseSchema);
    const shapes = choices.length ? choices.map((_, i) => chosen(p.responseSchema, i)) : [p.responseSchema];
    const properties = Object.assign({}, ...shapes.map((s) => shapeOf(s).properties));
    const fields = [...new Set(shapes.flatMap(asked))];
    const pick = choices.length ? '<label>Answer with<select data-choice>' + choices.map((c, i) => '<option value="' + i + '">' + esc(choiceName(c, i)) + '</option>').join('') + '</select></label>' : '';
    return '<form class="fields" onsubmit="return false">' + pick + fields.map((f) => f === 'prompt'
      ? '<label>' + esc(describe(properties[f], 'Your decision')) + '<textarea name="prompt" rows="4"></textarea></label>'
      : '<label>' + esc(describe(properties[f], f)) + '<input name="' + esc(f) + '"' + (properties[f] && Array.isArray(properties[f].enum) ? ' placeholder="one of: ' + esc(properties[f].enum.join(', ')) + '"' : '') + '></label>').join('')
      + '<button class="yes" data-request="' + id + '">Send</button></form>';
  }
  let schemas = new Map();
  // A refused answer's reason, kept on screen until the person sends again or the question goes.
  let refusal;
  async function answer(requestId, response) {
    refusal = undefined;
    const res = await fetch('answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId, response }) });
    const result = await res.json().catch(() => ({ ok: false, reason: 'no answer from the run' }));
    if (!result.ok) refusal = { requestId, text: 'the answer was refused: ' + (result.reason || res.status) };
    el('status').textContent = result.ok ? 'answered' : refusal.text;
    render();
  }
  el('pending').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-request]');
    if (!button) return;
    const requestId = button.getAttribute('data-request');
    const form = button.closest('form');
    const read = (field) => { const box = form.elements.namedItem(field); return box ? box.value : ''; };
    const choice = button.getAttribute('data-answer');
    if (choice) {
      const approved = choice === 'yes';
      const note = read('note');
      answer(requestId, note ? { approved, note } : { approved });
    } else {
      const picked = form.querySelector('select[data-choice]');
      answer(requestId, responseFor(schemas.get(requestId), read, picked ? Number(picked.value) : 0));
    }
  });
  async function render() {
    let s;
    try { s = await (await fetch('state', { cache: 'no-store' })).json(); } catch { el('status').textContent = 'the run has gone'; return; }
    el('title').textContent = (s.name || 'a run') + (s.status === 'done' ? ', ' + (s.outcome ? s.outcome.status : 'done') : ', running');
    if (refusal && !s.pending.some((p) => p.requestId === refusal.requestId)) refusal = undefined;
    el('status').textContent = refusal ? refusal.text : s.status === 'done' ? (s.outcome && s.outcome.summary ? s.outcome.summary : 'finished') : 'running' + (s.runId ? ' · ' + s.runId : '');
    el('usage').textContent = ' · ' + s.usageSummary;
    const names = Object.keys(s.nodes);
    el('nodes').innerHTML = names.map((n) => { const v = s.nodes[n]; return '<li><span class="name">' + esc(n) + (v.runs > 1 ? ' <span class="desc">ran ' + v.runs + ' times</span>' : '') + '</span>'
      + '<span>' + (v.desc ? '<div class="desc">' + esc(v.desc) + '</div>' : '') + (v.needs && v.needs.length ? '<div class="needs">needs ' + esc(v.needs.join(', ')) + '</div>' : '') + (v.outcome && v.outcome.summary ? '<div class="summary">' + esc(v.outcome.summary) + '</div>' : '') + '</span>'
      + '<span class="phase" data-phase="' + esc(v.phase) + '" data-status="' + esc(v.outcome ? v.outcome.status : '') + '">' + esc(v.phase === 'done' && v.outcome ? v.outcome.status : v.phase) + '</span></li>'; }).join('');
    el('kickbacks').innerHTML = s.kickbacks.map((k) => '<p class="kick">' + esc(k.from) + ' sent work back to ' + esc(k.to) + (k.accepted ? '' : ' (not accepted' + (k.note ? ': ' + esc(k.note) : '') + ')') + ': ' + esc(k.reason) + ' (' + k.count + (k.limit === undefined ? '' : ' of ' + k.limit) + ')</p>').join('');
    el('pending-title').hidden = s.pending.length === 0;
    schemas = new Map(s.pending.map((p) => [p.requestId, p.responseSchema]));
    // A card stays while its question waits, so neither a poll nor another question
    // arriving or going wipes what a person is typing into it.
    const box = el('pending');
    const shown = new Set();
    for (const card of [...box.children]) {
      const id = card.getAttribute('data-question');
      if (schemas.has(id)) shown.add(id); else card.remove();
    }
    for (const p of s.pending) {
      if (!shown.has(p.requestId)) box.insertAdjacentHTML('beforeend', '<div data-question="' + esc(p.requestId) + '"><p>' + esc(p.decisionText) + '</p>' + aboutHtml(p.input) + formHtml(p) + '</div>');
    }
    el('record').textContent = s.events.slice(-40).map((e) => new Date(e.ts).toISOString().slice(11, 19) + '  ' + e.line).join('\\n');
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
