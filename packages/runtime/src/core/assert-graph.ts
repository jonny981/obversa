/**
 * `assertGraph(job, shape)` — turn `jobMeta` introspection into test
 * assertions. The shape is a PARTIAL expectation: only asserted fields are
 * compared, and extra actual nodes are allowed unless `exactNodes: true`.
 * On mismatch it throws a plain `Error` whose message carries the JSON path
 * to the mismatch (e.g. `nodes[build].needs`) plus expected vs actual — the
 * message IS the API (vitest surfaces it verbatim).
 */

import type { Job, JobMeta } from './types.js';
import { jobMeta, type NodeMeta } from './describe.js';
import { LoopError } from './errors.js';

export interface GraphNodeShape {
  name: string;
  needs?: string[];
  optional?: boolean;
  /** A boolean meaning "a `when` gate exists" — the meta stores condition
   *  labels, so this is a presence check, not label equality. */
  when?: boolean;
  isolate?: boolean;
  /** Asserted against the node's nested job meta (`node.job.kind`). */
  kind?: string;
}

export interface GraphShape {
  kind?: string;
  name?: string;
  nodes?: GraphNodeShape[];
  /** Fail when the actual node set has names beyond `nodes`. */
  exactNodes?: boolean;
  body?: GraphShape;
  [key: string]: unknown;
}

const show = (v: unknown) => JSON.stringify(v) ?? 'undefined';

function fail(path: string, expected: unknown, actual: unknown): never {
  throw new Error(
    `assertGraph: ${path || '(root)'}: expected ${show(expected)}, got ${show(actual)}`,
  );
}

function sameSet(a: string[], b: string[]): boolean {
  // True set comparison: a duplicated entry on either side must not mask a
  // difference (a false pass is an assertion helper's worst failure mode).
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

function checkNode(node: NodeMeta, exp: GraphNodeShape, path: string): void {
  if (exp.needs && !sameSet(exp.needs, node.needs ?? []))
    fail(`${path}.needs`, exp.needs, node.needs ?? []);
  if (exp.optional !== undefined && (node.optional ?? false) !== exp.optional)
    fail(`${path}.optional`, exp.optional, node.optional ?? false);
  if (exp.isolate !== undefined && (node.isolate ?? false) !== exp.isolate)
    fail(`${path}.isolate`, exp.isolate, node.isolate ?? false);
  if (exp.when !== undefined && !!node.when?.length !== exp.when)
    fail(`${path}.when`, exp.when, node.when ?? []);
  if (exp.kind !== undefined && node.job?.kind !== exp.kind)
    fail(`${path}.kind`, exp.kind, node.job?.kind);
}

function check(meta: JobMeta, shape: GraphShape, path: string): void {
  const at = (field: string) => (path ? `${path}.${field}` : field);
  for (const [key, expected] of Object.entries(shape)) {
    if (key === 'nodes' || key === 'body' || key === 'exactNodes') continue;
    if (expected === undefined) continue;
    if (meta[key] !== expected) fail(at(key), expected, meta[key]);
  }
  if (shape.nodes) {
    const actual = (meta.nodes as NodeMeta[] | undefined) ?? [];
    for (const exp of shape.nodes) {
      const node = actual.find((n) => n.name === exp.name);
      if (!node)
        fail(at(`nodes[${exp.name}]`), 'a node', `missing (actual nodes: ${show(actual.map((n) => n.name))})`);
      checkNode(node, exp, at(`nodes[${exp.name}]`));
    }
    if (shape.exactNodes === true) {
      const expectedNames = shape.nodes.map((n) => n.name);
      const actualNames = actual.map((n) => n.name);
      if (!sameSet(expectedNames, actualNames))
        fail(at('nodes'), expectedNames, actualNames);
    }
  }
  if (shape.body) {
    const body = meta.body as JobMeta | undefined;
    if (!body) fail(at('body'), shape.body.kind ?? 'a job meta', undefined);
    check(body, shape.body, at('body'));
  }
}

/** Assert a job's introspected shape matches a partial expectation. Accepts the
 *  `Job` itself (resolved via `jobMeta`) or a `JobMeta` directly. */
export function assertGraph(job: Job | JobMeta, shape: GraphShape): void {
  const meta = typeof job === 'function' ? jobMeta(job) : job;
  if (!meta)
    throw new LoopError({
      code: 'CONFIG',
      message:
        'assertGraph: the job is not introspectable (no registered meta — only builder-made jobs carry a shape)',
    });
  check(meta, shape, '');
}
