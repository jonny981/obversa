/**
 * `pipeline(name, stages)` is declarative ordered stages as sugar over `dag()`: the
 * Job graph is the pipeline. Each stage becomes a dag node that `needs` the stage
 * before it; an explicit `needs` replaces that default, so fan-out/fan-in is still
 * just edges. All dag semantics apply unchanged: a skipped stage (unmet `when`) counts
 * green so the chain continues, and an optional stage's failure neither fails the
 * pipeline nor blocks the next stage (its consumers must tolerate its artifacts being
 * absent).
 */

import type {
  ConditionInput,
  DagConfig,
  DagNode,
  Job,
  JobMeta,
} from './types.js';
import { dag } from './dag.js';
import { jobMeta, type NodeMeta } from './describe.js';
import { LoopError } from './errors.js';

export interface PipelineStage {
  name: string;
  job: Job;
  /** Gate (one or many): when unmet the stage is skipped, not failed. */
  when?: ConditionInput;
  /** A failure here does not fail the pipeline, and does not block later stages. */
  optional?: boolean;
  /**
   * Explicit dependencies, replacing the default `[previous stage]` entirely
   * (`[]` detaches the stage). This is how a linear pipeline grows fan-out
   * (two stages needing the same producer) and fan-in (one stage needing both).
   */
  needs?: string[];
  /** Per-stage isolation override (dag's per-node `isolate`). */
  isolate?: boolean;
  /** Kickback allowlist for this stage (dag's per-node `acceptsKickbackTo`). */
  acceptsKickbackTo?: string[];
}

/** Ordered named stages, auto-chained: stage i needs stage i-1. Sugar over `dag`. */
export function pipeline(
  name: string,
  stages: PipelineStage[],
  opts?: Omit<DagConfig, 'name' | 'nodes'>,
): Job {
  if (stages.length === 0)
    throw new LoopError({
      code: 'CONFIG',
      message: `pipeline "${name}" requires at least one stage`,
    });
  // Null-prototype so every stage name lands as an own key (on a plain object
  // a name like "__proto__" would hit the Object.prototype accessor and the
  // stage would silently vanish into a 0-node, false-green dag), and so the
  // `in` duplicate guard sees only own keys. Own-key order is what the meta
  // and renderers replay; JS sorts integer-like keys first, so a stage named
  // "1" displays out of declared order (execution only reads the edges).
  const nodes: Record<string, DagNode> = Object.create(null);
  stages.forEach((stage, i) => {
    if (stage.name in nodes)
      throw new LoopError({
        code: 'CONFIG',
        message: `pipeline "${name}": duplicate stage name "${stage.name}"`,
      });
    nodes[stage.name] = {
      job: stage.job,
      needs: stage.needs ?? (i > 0 ? [stages[i - 1]!.name] : []),
      when: stage.when,
      optional: stage.optional,
      isolate: stage.isolate,
      acceptsKickbackTo: stage.acceptsKickbackTo,
    };
  });
  // A plain dag underneath: meta stays kind:'dag', so renderPlan and host views
  // read a pipeline like any other dag.
  return dag({ name, nodes, ...opts });
}

/**
 * Render a `kind:'dag'` job's stages as a GitHub-markdown table (one row per
 * node, in the meta's node order). Accepts the `Job` itself or its `JobMeta`.
 */
export function renderPipelineTable(source: Job | JobMeta): string {
  const meta = typeof source === 'function' ? jobMeta(source) : source;
  if (!meta || meta.kind !== 'dag')
    throw new LoopError({
      code: 'CONFIG',
      message: `renderPipelineTable requires a dag-shaped job (got ${meta ? `kind "${meta.kind}"` : 'no meta'})`,
    });
  const nodes = (meta.nodes as NodeMeta[] | undefined) ?? [];
  const rows = nodes.map((n, i) => {
    const needs = n.needs?.length ? n.needs.join(', ') : '—';
    const when = n.when?.length ? n.when.join(', ') : '—';
    const optional = n.optional ? 'yes' : '—';
    return `| ${i + 1} | ${n.name} | ${needs} | ${when} | ${optional} |`;
  });
  return [
    '| # | stage | needs | when | optional |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}
