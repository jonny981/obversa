/**
 * AgentDef — a reusable, job-specific agent definition. The persona and methodology
 * (the prose: `system`, skill `instructions`) live in editable markdown files; the
 * structure and types live here in TypeScript. The `.ts` is the strongly-typed wrapper
 * around the `.md` — author the prompt as markdown, get type safety and validation in code.
 *
 * Adapted from an application-specific agent profile without duplicating the orchestration
 * that the runtime already provides: `dag` is the dispatcher, `conditions`/`quorum` are the
 * gates, and `Outcome` is the result channel. AgentDef captures who the agent is, what it
 * may touch, and how it works; `agentJob` resolves that contract into an engine request.
 */

import { readFileSync } from 'node:fs';

/** A skill is a METHODOLOGY (how to do the work — TDD, writing-plans), not a worker.
 *  An agent composes skills; a skill never dispatches an agent. */
export interface Skill {
  name: string;
  /** The methodology instructions — prepended to the agent's system when it applies them. */
  instructions: string;
}

export type AgentTier =
  | 'worker'
  | 'reviewer'
  | 'lead'
  | 'specialist'
  | 'utility'
  | (string & {});

export type AgentSkillRef = string | Skill;

export interface AgentOutputContract {
  /** Stable output name, such as `patch`, `review`, or `test-report`. */
  name: string;
  description?: string;
  /** Optional structured schema owned by the loop author. The runtime stores it, it does not interpret it. */
  schema?: unknown;
}

export interface AgentFailureMode {
  mode: string;
  recovery: string;
  detection?: string;
  severity?: 'block' | 'should-fix' | 'nice-to-have' | (string & {});
}

export interface AgentDef {
  /** Identity (also the default job label). */
  name: string;
  /** What and why — for humans, docs, and package discovery. */
  description?: string;
  /** The system prompt: who the agent is and how it works. Use `fromFile('x.md')`. */
  system: string;
  /** Model id; omitted = inherit the run default. */
  model?: string;
  /** Allowed tool names — the permission boundary. */
  tools?: string[];
  /**
   * Mark this agent a leaf: it may not spawn sub-agents / fan out (the engine disallows
   * the sub-agent tool). Use it to control where a branch of the graph bottoms out — to
   * stop a thorough agent from quietly expanding into a slow, expensive swarm.
   */
  leaf?: boolean;
  /** Contract tier for humans, describe output, and future discovery. No scheduling authority. */
  tier?: AgentTier;
  /** Structured job descriptions (not prose) — for discovery / docs. */
  capabilities?: string[];
  /** Structured outputs this agent is expected to produce. */
  outputs?: AgentOutputContract[];
  /** Methodologies the agent applies; their instructions are folded into the system. */
  skills?: Skill[];
  /** Skills the caller should supply before the turn. Metadata only unless also listed in `skills`. */
  requiresSkills?: AgentSkillRef[];
  /** Skills the agent is known to use. Metadata only unless also listed in `skills`. */
  usesSkills?: AgentSkillRef[];
  /** Named failure modes + their recovery — first-class contracts, not buried prose. */
  failureModes?: AgentFailureMode[];
}

export interface AgentContractSummary {
  tier?: string;
  capabilities?: string[];
  outputs?: string[];
  requiresSkills?: string[];
  usesSkills?: string[];
  failureModes?: string[];
}

/** Read a markdown file as a string — for `system` or skill `instructions`. Pass an
 *  absolute path, or `new URL('./x.md', import.meta.url)` for a path relative to the file. */
export function fromFile(path: string | URL): string {
  return readFileSync(path, 'utf8').trim();
}

/** Define a skill (a methodology). Identity + validation; strongly typed. */
export function defineSkill(skill: Skill): Skill {
  if (!skill.name) throw new Error('defineSkill: `name` is required');
  if (!skill.instructions?.trim()) throw new Error(`defineSkill "${skill.name}": empty instructions`);
  return skill;
}

function skillRefName(ref: AgentSkillRef): string {
  return typeof ref === 'string' ? ref : ref.name;
}

function validateName(value: string | undefined, label: string): void {
  if (!value?.trim()) throw new Error(`${label}: \`name\` is required`);
}

function validateSkillRef(ref: AgentSkillRef, label: string): void {
  if (typeof ref === 'string') {
    if (!ref.trim()) throw new Error(`${label}: empty skill name`);
    return;
  }
  defineSkill(ref);
}

/** Define an agent. Identity + validation; strongly typed (the wrapper around the md). */
export function defineAgent(def: AgentDef): AgentDef {
  if (!def.name) throw new Error('defineAgent: `name` is required');
  if (!def.system?.trim()) throw new Error(`defineAgent "${def.name}": empty system prompt`);
  def.skills?.forEach((s) => defineSkill(s));
  def.requiresSkills?.forEach((s) =>
    validateSkillRef(s, `defineAgent "${def.name}" requiresSkills`),
  );
  def.usesSkills?.forEach((s) =>
    validateSkillRef(s, `defineAgent "${def.name}" usesSkills`),
  );
  def.outputs?.forEach((o) =>
    validateName(o.name, `defineAgent "${def.name}" outputs`),
  );
  def.failureModes?.forEach((f) => {
    if (!f.mode?.trim())
      throw new Error(`defineAgent "${def.name}" failureModes: \`mode\` is required`);
    if (!f.recovery?.trim())
      throw new Error(`defineAgent "${def.name}" failureModes "${f.mode}": \`recovery\` is required`);
  });
  return def;
}

export function agentContract(agent: AgentDef | undefined): AgentContractSummary | undefined {
  if (!agent) return undefined;
  const summary: AgentContractSummary = {};
  if (agent.tier) summary.tier = agent.tier;
  if (agent.capabilities?.length) summary.capabilities = [...agent.capabilities];
  if (agent.outputs?.length) summary.outputs = agent.outputs.map((o) => o.name);
  if (agent.requiresSkills?.length)
    summary.requiresSkills = agent.requiresSkills.map(skillRefName);
  if (agent.usesSkills?.length)
    summary.usesSkills = agent.usesSkills.map(skillRefName);
  if (agent.failureModes?.length)
    summary.failureModes = agent.failureModes.map((f) => f.mode);
  return Object.keys(summary).length ? summary : undefined;
}

/**
 * Resolve an agent's system prompt, folding in its skills' methodologies. This is what
 * `agentJob` hands the engine as `system`.
 */
export function resolveSystem(agent: AgentDef): string {
  if (!agent.skills?.length) return agent.system;
  const methods = agent.skills
    .map((s) => `### ${s.name}\n\n${s.instructions.trim()}`)
    .join('\n\n');
  return `${agent.system.trim()}\n\n## Methodologies you apply\n\n${methods}`;
}
