import type { CallbackGateDefinition } from '../callback/gate.js';
import { createCallbackGate } from '../callback/gate.js';
import type { EngineRef } from '../engines/engine.js';
import { childContext } from './context.js';
import { setMeta } from './describe.js';
import { LoopError } from './errors.js';
import { agentJob } from './job.js';
import { isolated, type IsolatedOptions } from './isolated.js';
import { parallel } from './dag.js';
import { reviewPanel, type ReviewPanelConfig } from './feedback.js';
import type { Job, Outcome } from './types.js';

export interface TeamAgent {
  name: string;
  role: string;
  brief: string;
  engine: EngineRef;
}

export type TeamReview =
  | { kind: 'panel'; config: ReviewPanelConfig }
  | { kind: 'callback'; definition: CallbackGateDefinition };

export interface TeamConfig {
  task: string;
  agents: readonly TeamAgent[];
  integrate?: Pick<IsolatedOptions, 'onConflict'>;
  review?: TeamReview;
}

export interface TeamAgentResult {
  name: string;
  role: string;
  outcome: Outcome;
}

export interface TeamResult {
  task: string;
  agents: readonly TeamAgentResult[];
  integrated: boolean;
  review?: Outcome;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LoopError({
      code: 'CONFIG',
      message: `team() requires a non-empty ${field}`,
    });
  }
  return value;
}

function validateConfig(config: TeamConfig): void {
  requireText(config.task, 'task');
  if (!Array.isArray(config.agents) || config.agents.length === 0) {
    throw new LoopError({
      code: 'CONFIG',
      message: 'team() requires at least one agent',
    });
  }
  const names = new Set<string>();
  for (const agent of config.agents) {
    const name = requireText(agent.name, 'agent name');
    if (names.has(name)) {
      throw new LoopError({
        code: 'CONFIG',
        message: `team() agent name is duplicated: ${name}`,
      });
    }
    names.add(name);
    requireText(agent.role, `role for ${name}`);
    requireText(agent.brief, `brief for ${name}`);
    if (agent.engine === undefined || agent.engine === null) {
      throw new LoopError({
        code: 'CONFIG',
        message: `team() requires an engine for ${name}`,
      });
    }
  }
}

function promptFor(task: string, agent: TeamAgent): string {
  return [
    `Task: ${task}`,
    `Role: ${agent.role}`,
    `Brief: ${agent.brief}`,
  ].join('\n\n');
}

function memberResults(
  agents: readonly TeamAgent[],
  outcome: Outcome,
): TeamAgentResult[] {
  const results = (outcome.data ?? {}) as Record<string, Outcome>;
  return agents.map((agent, index) => ({
    name: agent.name,
    role: agent.role,
    outcome: results[`task-${index}`] ?? {
      status: 'fail',
      summary: `team member ${agent.name} returned no outcome`,
    },
  }));
}

function teamMeta(config: TeamConfig) {
  return {
    kind: 'team',
    name: 'team',
    agents: config.agents.map(({ name, role }) => ({ name, role })),
    ...(config.integrate ? { integrate: { ...config.integrate } } : {}),
    ...(config.review ? { review: config.review.kind } : {}),
  };
}

export function team(config: TeamConfig): Job {
  validateConfig(config);
  const job: Job = async (ctx) => {
    const memberJobs = config.agents.map((agent) =>
      isolated(
        agentJob({
          label: agent.name,
          engine: agent.engine,
          prompt: promptFor(config.task, agent),
        }),
        {
          label: `team-${agent.name}`,
          onConflict: config.integrate?.onConflict,
        },
      ),
    );
    const members = await parallel('team-members', memberJobs, memberJobs.length)(ctx);
    const agents = memberResults(config.agents, members);
    const result: TeamResult = {
      task: config.task,
      agents,
      integrated: members.status === 'pass',
    };

    if (members.status !== 'pass') {
      return { ...members, data: result };
    }

    if (config.review?.kind === 'panel') {
      const reviewContext = childContext(ctx, {
        depth: ctx.depth + 1,
        path: [...ctx.path, 'team-review'],
        lastOutcome: { ...members, data: result },
        lastReview: ctx.lastReview,
        lastGate: ctx.lastGate,
      });
      const review = await reviewPanel(config.review.config)(reviewContext);
      const reviewed: TeamResult = { ...result, review };
      if (review.status !== 'pass') return { ...review, data: reviewed };
      return { ...members, data: reviewed };
    }

    if (config.review?.kind === 'callback') {
      const request = createCallbackGate(config.review.definition);
      const review: Outcome = {
        status: 'paused',
        summary: `Team review "${request.gateId}" is waiting for a callback`,
        data: request,
      };
      return { ...review, data: { ...result, review } };
    }

    return { ...members, data: result };
  };
  return setMeta(job, teamMeta(config));
}
