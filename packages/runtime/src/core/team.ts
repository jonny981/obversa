import type { CallbackGateDefinition, CallbackRequest } from '../callback/gate.js';
import { createCallbackGate } from '../callback/gate.js';
import type { EngineRef } from '../engines/engine.js';
import type { JsonObject, JsonValue } from '../graph/value.js';
import { childContext } from './context.js';
import { setMeta } from './describe.js';
import { LoopError } from './errors.js';
import { jsonSnapshot, outcomeSnapshot } from './interaction.js';
import { agentJob } from './job.js';
import { isolated } from './isolated.js';
import { parallel } from './dag.js';
import type { ReviewPanelConfig } from './feedback.js';
import { reviewPanel } from './synthesis.js';
import type { Job, Outcome, RunCallbacks } from './types.js';

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
  /** The callback review's question, while it waits for an answer. */
  requestId?: string;
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
    ...(config.review ? { review: config.review.kind } : {}),
  };
}

/** The submitted answer to the request, or undefined while nobody has answered. */
async function answerOf(client: RunCallbacks, request: CallbackRequest): Promise<JsonValue | undefined> {
  const history = await client.history(request.requestId);
  const submitted = history.findLast((event) => event.kind === 'callback-submitted');
  return submitted?.kind === 'callback-submitted' ? submitted.response : undefined;
}

/** An answer with `approved: false` fails the review; any other answer passes it. */
function reviewOf(request: CallbackRequest, answer: JsonValue): Outcome {
  const record: JsonObject = answer !== null && typeof answer === 'object' && !Array.isArray(answer) ? answer as JsonObject : {};
  if (record.approved === false) {
    const note = typeof record.note === 'string' && record.note !== '' ? record.note : `refused: ${request.decisionText}`;
    return { status: 'fail', summary: note, data: answer };
  }
  return { status: 'pass', summary: `approved: ${request.decisionText}`, data: answer };
}

export function team(config: TeamConfig): Job {
  validateConfig(config);
  const panel = config.review?.kind === 'panel' ? reviewPanel(config.review.config) : undefined;
  const definition = config.review?.kind === 'callback' ? config.review.definition : undefined;
  // Check the definition before any member runs; each call asks its own question below.
  if (definition) createCallbackGate(definition);
  const job: Job = async (ctx) => {
    const client = ctx.callbacks;
    if (definition && !client) {
      throw new LoopError({ code: 'CONFIG', message: 'a team callback review needs the run callbacks client' });
    }
    const memberJobs = config.agents.map((agent) =>
      isolated(
        agentJob({
          label: agent.name,
          engine: agent.engine,
          prompt: promptFor(config.task, agent),
        }),
        {
          label: `team-${agent.name}`,
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

    if (panel) {
      const reviewContext = childContext(ctx, {
        depth: ctx.depth + 1,
        path: [...ctx.path, 'team-review'],
        lastOutcome: { ...members, data: result },
        lastReview: ctx.lastReview,
        lastGate: ctx.lastGate,
      });
      const review = await panel(reviewContext);
      const reviewed: TeamResult = { ...result, review };
      if (review.status !== 'pass') return { ...review, data: reviewed };
      return { ...members, data: reviewed };
    }

    if (definition && client) {
      // The place, the loop iteration and the members' work key the question,
      // so a team run again, or a second team, asks a new one.
      const request = createCallbackGate({
        ...definition,
        input: jsonSnapshot({
          requester: { path: ctx.path, iteration: ctx.iteration },
          material: definition.input,
          team: { task: config.task, agents: agents.map((agent) => ({ ...agent, outcome: outcomeSnapshot(agent.outcome) })) },
        }),
      });
      let answer = await answerOf(client, request);
      if (answer === undefined) {
        await client.post(request);
        answer = await answerOf(client, request);
      }
      if (answer === undefined) {
        const review: Outcome = {
          status: 'paused',
          summary: `Team review "${request.gateId}" is waiting for a callback`,
          data: request,
        };
        return { ...review, data: { ...result, requestId: request.requestId, review } };
      }
      const review = reviewOf(request, answer);
      const reviewed: TeamResult = { ...result, review };
      if (review.status !== 'pass') return { ...review, data: reviewed };
      return { ...members, data: reviewed };
    }

    return { ...members, data: result };
  };
  return setMeta(job, teamMeta(config));
}
