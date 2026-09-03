/**
 * The convergence graph type (roadmap D7): fresh-context convergence with
 * real done checks, narrow repair rounds, and no repeated reviews whose
 * evidence is still valid.
 *
 * Nodes: `generator` (the body), `evaluator` (a data-only done gate), one
 * node per review seat — seats are separate nodes, one node bound to one
 * lane — and `repair` (the fixer). The convergence cycle is legal: repair
 * re-enters the body.
 *
 * Terminal mapping (decided with the runtime owner): pass → `complete`;
 * iterations, review restarts, or a recurring finding exhausted → `fail`
 * with a typed exhaustion code; `ABORTED` → `pause` with a reason; and
 * `ENGINE_UNAVAILABLE` skips a declared skippable seat or pauses a required
 * seat. Other executor failures are not review verdicts: a seat that fails
 * consumes no repair attempt and reruns within the declared retry cap. A
 * recorded `limit-paused` event pauses rate- or credit-limited work until a
 * later dispatch succeeds. A skipped seat never weakens the remaining
 * quorum and provider-diversity rules.
 *
 * This is the pure form only: definition validation, state reduction,
 * decisions, bounds, and the plan description. Panel policy helpers,
 * watched-path invalidation sources, and review acceptance records are
 * the runtime owner's.
 *
 * Event vocabulary (all JSON, recorded into the durable `graph:`
 * namespace):
 * - `node-dispatched` / `node-completed` / `node-failed` /
 *   `node-paused` / `node-resumed` — the standard node events; a seat's
 *   completed result carries the verdict record: verdict (`pass` |
 *   `findings` | `low-confidence`), confidence, the effective provider
 *   and model family, the reviewed input hashes, the workspace fingerprint,
 *   and any findings; the evaluator's completed result carries `gateMet`
 *   with the same evidence identity; the generator's and repair's results
 *   carry the work summaries.
 * - `seat-invalidated` — a seat's recorded verdict is no longer current
 *   (watched paths or fingerprints changed): the seat reruns.
 * - `seat-skip` — a skippable seat is recorded skipped for exhausted
 *   credit.
 *
 * A dispatch, completion, or failure counts only for the node's attempt
 * currently in flight at that exact position; a stale event from an
 * earlier attempt is ignored. Positions are minted per recorded dispatch:
 * `convergence/${iteration}/${node}` for the loop nodes and
 * `review/${round}/${seat}` for seats, so a retry or a rerun always takes
 * a fresh position. Retry is graph policy, declared as a per-node cap:
 * decide offers a fresh dispatch for a failed node while the cap allows,
 * and the run fails the node only once its cap is exhausted.
 *
 * Each review decision dispatches every seat that is pending or invalid
 * and fits the declared seat concurrency, in declaration order. Seats
 * whose recorded verdicts are still valid are never re-emitted — the D2
 * rule that a graph does not re-emit an occurrence already recorded in
 * the folded event history.
 */

import { isDeepStrictEqual } from 'node:util';

import type { GraphCommand } from '../graph/commands.js';
import type { GraphDefinition, NodeId } from '../graph/kernel.js';
import type { ExecutionLaneDescription, GraphDescriptionInput } from '../graph/plan.js';
import type { GraphEvent, GraphType } from '../graph/type.js';
import { GraphValidationError, type GraphValidationIssue, type JsonObject, type JsonValue } from '../graph/value.js';

type ConvergenceExecutionTargetData = {
  readonly adapter: string;
  readonly provider: string;
  readonly modelFamily: string;
  readonly model: string;
  readonly tools: readonly string[];
};

type ConvergenceExecutionLaneData = {
  readonly id: string;
  readonly requested: ConvergenceExecutionTargetData;
  readonly knownSubstitutions: readonly ConvergenceExecutionTargetData[];
};

export type ConvergenceNodeData = JsonObject & {
  /** `generator`, `evaluator`, `repair`, or `seat`. */
  readonly role: 'generator' | 'evaluator' | 'repair' | 'seat';
  /** Engine lane for this node; omit it for a data-only node. */
  readonly lane?: ConvergenceExecutionLaneData;
};

export interface ConvergenceEdgeData extends JsonObject {}

export interface ConvergenceFinding extends JsonObject {
  readonly id: string;
  readonly kind: 'patch' | 'decision';
  readonly evidence: string;
}

export interface ConvergenceData extends JsonObject {
  /** Body iterations bound. */
  readonly maxIterations: number;
  /** Repair rounds bound. */
  readonly maxReviewRestarts: number;
  /** Valid passing seats required to accept. */
  readonly quorum: number;
  /** Require distinct providers and model families among accepted seats. */
  readonly requireDiversity: boolean;
  /** Seat node ids that may be skipped for exhausted credit. */
  readonly skippableSeats: readonly string[];
  /** Review seats dispatchable at once. */
  readonly seatConcurrency: number;
  /** Retries offered per failed node before the run fails it. */
  readonly retryCapPerNode: number;
}

export type ConvergenceDefinition = GraphDefinition<
  ConvergenceNodeData,
  ConvergenceEdgeData,
  ConvergenceData
>;

export interface NodeDispatchedPayload extends JsonObject {
  readonly nodeId: NodeId;
  readonly position: string;
}

export interface NodeCompletedPayload extends JsonObject {
  readonly nodeId: NodeId;
  readonly position: string;
  readonly result: JsonValue;
}

export interface NodeFailedPayload extends JsonObject {
  readonly nodeId: NodeId;
  readonly position: string;
  readonly code: string;
}

export interface NodePausedPayload extends JsonObject {
  readonly nodeId: NodeId;
  readonly position: string;
  readonly reason: string;
  readonly request: JsonValue;
}

export interface NodeResumedPayload extends JsonObject {
  readonly nodeId: NodeId;
}

export interface LimitPausedPayload extends JsonObject {
  readonly reason: string;
}

export interface SeatInvalidatedPayload extends JsonObject {
  readonly seatId: NodeId;
  readonly reason: string;
}

export interface SeatSkipPayload extends JsonObject {
  readonly seatId: NodeId;
  readonly reason: string;
}

export type ConvergenceEvent =
  | GraphEvent<'node-dispatched', NodeDispatchedPayload>
  | GraphEvent<'node-completed', NodeCompletedPayload>
  | GraphEvent<'node-failed', NodeFailedPayload>
  | GraphEvent<'node-paused', NodePausedPayload>
  | GraphEvent<'node-resumed', NodeResumedPayload>
  | GraphEvent<'seat-invalidated', SeatInvalidatedPayload>
  | GraphEvent<'seat-skip', SeatSkipPayload>
  | GraphEvent<'limit-paused', LimitPausedPayload>;

export type LoopNodeStatus =
  | 'pending'
  | 'in-flight'
  | 'paused'
  | 'passed'
  | 'failed';

export interface LoopNodeState extends JsonObject {
  readonly status: LoopNodeStatus;
  readonly attempts: number;
  readonly inFlight: string | null;
}

export type SeatOutcome =
  | 'valid'
  | 'invalid'
  | 'skipped'
  | 'non-verdict'
  | null;

export interface SeatRecord extends JsonObject {
  readonly outcome: SeatOutcome;
  readonly verdict: 'pass' | 'findings' | 'low-confidence' | null;
  readonly confidence: number | null;
  readonly provider: string | null;
  readonly modelFamily: string | null;
  readonly inputHashes: JsonObject | null;
  readonly workspaceFingerprint: string | null;
  readonly findings: readonly ConvergenceFinding[];
  /** Set when the seat was invalidated while its attempt was in flight; the late verdict is discarded. */
  readonly stale: boolean;
}

export interface ConvergenceStatus extends JsonObject {
  readonly phase: 'body' | 'review' | 'settled';
  readonly iteration: number;
  readonly restarts: number;
  readonly nodes: Readonly<Record<NodeId, LoopNodeState>>;
  readonly seats: Readonly<Record<NodeId, SeatRecord>>;
  readonly reviewEvidence: ConvergenceReviewEvidence | null;
  /** Times each finding id has been reported across review rounds. */
  readonly findingRounds: Readonly<Record<string, number>>;
  /** A typed pause reason set by a limit or credit failure, or null. */
  readonly pauseReason: string | null;
}

export interface ConvergenceReviewEvidence extends JsonObject {
  readonly inputHashes: JsonObject;
  readonly workspaceFingerprint: string;
}

export type ConvergenceRequirements = { readonly memory: 'unused' };

const ROLES = new Set(['generator', 'evaluator', 'repair', 'seat']);

function issue(code: string, path: string, message: string): GraphValidationIssue {
  return { code, path, message };
}

function validateConvergence(definition: ConvergenceDefinition): Readonly<{
  seats: readonly NodeId[];
  executionLanes: ReadonlyMap<string, ExecutionLaneDescription>;
}> {
  const issues: GraphValidationIssue[] = [];
  const byRole = new Map<string, NodeId[]>();
  const executionLanes = new Map<string, ExecutionLaneDescription>();
  for (const node of definition.nodes) {
    if (!ROLES.has(node.data.role)) {
      issues.push(issue(
        'INVALID_ROLE',
        `/nodes/${node.id}/data/role`,
        `Node role must be generator, evaluator, repair, or seat; received ${JSON.stringify(node.data.role)}.`,
      ));
      continue;
    }
    const list = byRole.get(node.data.role) ?? [];
    list.push(node.id);
    byRole.set(node.data.role, list);
    const lane = node.data.lane;
    if (lane !== undefined) {
      const declared = executionLanes.get(lane.id);
      if (declared !== undefined && !isDeepStrictEqual(declared, lane)) {
        issues.push(issue(
          'CONFLICTING_LANE',
          `/nodes/${node.id}/data/lane`,
          `Lane "${lane.id}" must have the same declaration on every node that uses it.`,
        ));
      } else {
        executionLanes.set(lane.id, lane);
      }
    }
  }

  for (const role of ['generator', 'evaluator', 'repair'] as const) {
    if ((byRole.get(role) ?? []).length !== 1) {
      issues.push(issue(
        'ROLE_COUNT',
        '/nodes',
        `Exactly one ${role} node is required.`,
      ));
    }
  }
  const seats = byRole.get('seat') ?? [];
  if (seats.length === 0) {
    issues.push(issue('ROLE_COUNT', '/nodes', 'At least one seat node is required.'));
  }

  for (const [field, minimum] of [
    ['maxIterations', 1],
    ['maxReviewRestarts', 0],
    ['quorum', 1],
    ['seatConcurrency', 1],
    ['retryCapPerNode', 0],
  ] as const) {
    const value = (definition.data as Record<string, unknown>)[field];
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
      issues.push(issue(
        'INVALID_LIMIT',
        `/data/${field}`,
        `${field} must be a safe integer of at least ${minimum}.`,
      ));
    }
  }

  if (Number.isSafeInteger(definition.data.quorum)
    && definition.data.quorum > seats.length) {
    issues.push(issue(
      'INVALID_QUORUM',
      '/data/quorum',
      `quorum cannot exceed the seat count (${seats.length}).`,
    ));
  }

  if (typeof definition.data.requireDiversity !== 'boolean') {
    issues.push(issue(
      'INVALID_DIVERSITY',
      '/data/requireDiversity',
      'requireDiversity must be a boolean.',
    ));
  }

  const seatIds = new Set(seats);
  if (Array.isArray(definition.data.skippableSeats)) {
    for (const [index, id] of definition.data.skippableSeats.entries()) {
      if (!seatIds.has(id)) {
        issues.push(issue(
          'UNKNOWN_SEAT',
          `/data/skippableSeats/${index}`,
          `Skippable seat "${String(id)}" is not a declared seat node.`,
        ));
      }
    }
  } else {
    issues.push(issue(
      'INVALID_SKIPPABLE',
      '/data/skippableSeats',
      'skippableSeats must be an array of seat node ids.',
    ));
  }

  if (issues.length > 0) {
    throw new GraphValidationError('Invalid convergence definition.', issues);
  }
  return { seats, executionLanes };
}

function asRecord(value: JsonValue): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * The convergence graph type. Pure data operations only (the D2 contract).
 */
export const convergence: GraphType<
  ConvergenceDefinition,
  ConvergenceStatus,
  ConvergenceEvent,
  ConvergenceRequirements
> = {
  kind: 'convergence',
  version: 1,
  compile(definition) {
    const { seats, executionLanes } = validateConvergence(definition);
    const seatSet = new Set(seats);
    const generator = definition.nodes.find((node) => node.data.role === 'generator')!.id;
    const evaluator = definition.nodes.find((node) => node.data.role === 'evaluator')!.id;
    const repair = definition.nodes.find((node) => node.data.role === 'repair')!.id;
    const skippable = new Set(definition.data.skippableSeats);

    const initialNodes = (): Record<NodeId, LoopNodeState> =>
      Object.fromEntries(definition.nodes.map((node) => [
        node.id,
        { status: 'pending', attempts: 0, inFlight: null },
      ]));
    const initialSeats = (): Record<NodeId, SeatRecord> =>
      Object.fromEntries(seats.map((id) => [
        id,
        {
          outcome: null,
          verdict: null,
          confidence: null,
          provider: null,
          modelFamily: null,
          inputHashes: null,
          workspaceFingerprint: null,
          findings: [],
          stale: false,
        },
      ]));

    const seatOf = (nodeId: NodeId): boolean => seatSet.has(nodeId);

    const nodeState = (
      status: LoopNodeStatus,
      attempts: number,
      inFlight: string | null,
    ): LoopNodeState => ({ status, attempts, inFlight });

    const readReviewEvidence = (result: JsonValue): ConvergenceReviewEvidence | null => {
      const record = asRecord(result);
      const inputHashes = asRecord(record?.inputHashes as JsonValue);
      if (
        inputHashes === null
        || Object.values(inputHashes).some((value) => typeof value !== 'string')
        || typeof record?.workspaceFingerprint !== 'string'
      ) return null;
      return {
        inputHashes: inputHashes as JsonObject,
        workspaceFingerprint: record.workspaceFingerprint,
      };
    };

    const sameReviewEvidence = (
      left: ConvergenceReviewEvidence | null,
      right: ConvergenceReviewEvidence | null,
    ): boolean => left !== null && right !== null && isDeepStrictEqual(left, right);

    const readVerdict = (
      result: JsonValue,
      currentEvidence: ConvergenceReviewEvidence | null,
    ): SeatRecord => {
      const record = asRecord(result) ?? {};
      const evidence = readReviewEvidence(result);
      const verdict = record.verdict === 'pass' || record.verdict === 'findings'
        || record.verdict === 'low-confidence'
        ? record.verdict
        : null;
      const findings = Array.isArray(record.findings)
        ? record.findings.filter((finding): finding is ConvergenceFinding => {
          const candidate = asRecord(finding);
          return candidate !== null
            && typeof candidate.id === 'string'
            && (candidate.kind === 'patch' || candidate.kind === 'decision')
            && typeof candidate.evidence === 'string';
        })
        : [];
      // Only an accepted pass is reusable evidence, and never a pass with
      // missing confidence; a findings verdict must re-verify after a
      // repair, like the roadmap's repair fixture reruns the seat that
      // reported the finding.
      const trusted = verdict === 'pass'
        && typeof record.confidence === 'number'
        && sameReviewEvidence(evidence, currentEvidence);
      return {
        outcome: trusted ? 'valid' : verdict === null ? null : 'invalid',
        verdict,
        confidence: typeof record.confidence === 'number' ? record.confidence : null,
        provider: typeof record.provider === 'string' ? record.provider : null,
        modelFamily: typeof record.modelFamily === 'string' ? record.modelFamily : null,
        inputHashes: evidence?.inputHashes ?? null,
        workspaceFingerprint: evidence?.workspaceFingerprint ?? null,
        findings,
        stale: false,
      };
    };

    const gateMet = (result: JsonValue): boolean => {
      const record = asRecord(result);
      return record !== null && record.gateMet === true;
    };

    const validSeats = (state: ConvergenceStatus): readonly NodeId[] =>
      seats.filter((id) => state.seats[id]!.outcome === 'valid');

    const acceptedPasses = (state: ConvergenceStatus): readonly NodeId[] =>
      validSeats(state).filter((id) => state.seats[id]!.verdict === 'pass');

    const diversityHolds = (state: ConvergenceStatus): boolean => {
      if (!definition.data.requireDiversity) return true;
      const familiesByProvider = new Map<string, Set<string>>();
      for (const id of acceptedPasses(state)) {
        const seat = state.seats[id]!;
        if (seat.provider === null || seat.modelFamily === null) continue;
        const families = familiesByProvider.get(seat.provider) ?? new Set<string>();
        families.add(seat.modelFamily);
        familiesByProvider.set(seat.provider, families);
      }
      const providerByFamily = new Map<string, string>();
      const match = (provider: string, visited: Set<string>): boolean => {
        for (const family of familiesByProvider.get(provider) ?? []) {
          if (visited.has(family)) continue;
          visited.add(family);
          const owner = providerByFamily.get(family);
          if (owner === undefined || match(owner, visited)) {
            providerByFamily.set(family, provider);
            return true;
          }
        }
        return false;
      };
      let diverse = 0;
      for (const provider of familiesByProvider.keys()) {
        if (match(provider, new Set())) diverse += 1;
      }
      return diverse >= definition.data.quorum;
    };

    const quorumHolds = (state: ConvergenceStatus): boolean =>
      acceptedPasses(state).length >= definition.data.quorum && diversityHolds(state);

    const blockingFindings = (state: ConvergenceStatus): readonly ConvergenceFinding[] =>
      seats.flatMap((id) => state.seats[id]!.verdict === 'findings'
        ? state.seats[id]!.findings
        : []);

    return {
      requirements: { memory: 'unused' },
      initialState: () => ({
        phase: 'body',
        iteration: 1,
        restarts: 0,
        nodes: initialNodes(),
        seats: initialSeats(),
        reviewEvidence: null,
        findingRounds: {},
        pauseReason: null,
      }),
      reduce(state, event) {
        const node = state.nodes[event.payload.nodeId as NodeId];
        switch (event.type) {
          case 'node-dispatched': {
            if (node === undefined) return state;
            if (!event.payload.position.endsWith(`/${node.attempts + 1}`)) return state;
            if (node.status !== 'pending' && node.status !== 'failed') return state;
            return {
              ...state,
              pauseReason: null,
              nodes: {
                ...state.nodes,
                [event.payload.nodeId]: nodeState(
                  'in-flight',
                  node.attempts + 1,
                  event.payload.position,
                ),
              },
            };
          }
          case 'node-completed': {
            if (node === undefined || node.status !== 'in-flight') return state;
            if (node.inFlight !== event.payload.position) return state;
            const resetForNextRound = (nodes: Record<NodeId, LoopNodeState>): Record<NodeId, LoopNodeState> => {
              const next = { ...nodes };
              for (const id of [generator, evaluator, repair]) {
                next[id] = nodeState('pending', next[id]!.attempts, null);
              }
              for (const id of seats) {
                if (state.seats[id]!.outcome !== 'valid') {
                  next[id] = nodeState('pending', next[id]!.attempts, null);
                }
              }
              return next;
            };
            const nodes = {
              ...state.nodes,
              [event.payload.nodeId]: nodeState('passed', node.attempts, null),
            };
            if (seatOf(event.payload.nodeId)) {
              const current = state.seats[event.payload.nodeId]!;
              // A verdict that arrives after the seat was invalidated while
              // in flight is discarded: the evidence it covered is gone.
              const verdict = current.stale
                ? {
                    outcome: 'invalid' as const,
                    verdict: null,
                    confidence: null,
                    provider: null,
                    modelFamily: null,
                    inputHashes: null,
                    workspaceFingerprint: null,
                    findings: [] as readonly ConvergenceFinding[],
                    stale: false,
                  }
                : readVerdict(event.payload.result, state.reviewEvidence);
              const findingRounds = { ...state.findingRounds };
              for (const finding of verdict.findings) {
                findingRounds[finding.id] = (findingRounds[finding.id] ?? 0) + 1;
              }
              return {
                ...state,
                nodes: current.stale || (verdict.verdict === 'pass' && verdict.outcome !== 'valid')
                  ? {
                      ...nodes,
                      [event.payload.nodeId]: nodeState('pending', node.attempts, null),
                    }
                  : nodes,
                seats: {
                  ...state.seats,
                  [event.payload.nodeId]: verdict,
                },
                findingRounds,
              };
            }
            if (event.payload.nodeId === evaluator) {
              const reviewEvidence = readReviewEvidence(event.payload.result);
              if (gateMet(event.payload.result)) {
                const nextNodes = { ...nodes };
                const nextSeats = { ...state.seats };
                for (const id of seats) {
                  const seat = state.seats[id]!;
                  const recordedEvidence = seat.inputHashes === null
                    || seat.workspaceFingerprint === null
                    ? null
                    : {
                        inputHashes: seat.inputHashes,
                        workspaceFingerprint: seat.workspaceFingerprint,
                      };
                  if (seat.outcome === 'valid'
                    && !sameReviewEvidence(recordedEvidence, reviewEvidence)) {
                    nextNodes[id] = nodeState('pending', nextNodes[id]!.attempts, null);
                    nextSeats[id] = {
                      ...seat,
                      outcome: 'invalid',
                      verdict: null,
                      confidence: null,
                      inputHashes: null,
                      workspaceFingerprint: null,
                      findings: [],
                    };
                  }
                }
                return {
                  ...state,
                  nodes: nextNodes,
                  seats: nextSeats,
                  reviewEvidence,
                  phase: 'review',
                };
              }
              if (state.iteration >= definition.data.maxIterations) {
                return { ...state, nodes, phase: 'settled' };
              }
              const next = { ...nodes };
              next[generator] = nodeState('pending', next[generator]!.attempts, null);
              next[evaluator] = nodeState('pending', next[evaluator]!.attempts, null);
              return {
                ...state,
                nodes: next,
                reviewEvidence,
                iteration: state.iteration + 1,
                phase: 'body',
              };
            }
            if (event.payload.nodeId === repair) {
              if (state.restarts >= definition.data.maxReviewRestarts) {
                return { ...state, nodes, phase: 'settled' };
              }
              return {
                ...state,
                nodes: resetForNextRound(nodes),
                restarts: state.restarts + 1,
                iteration: state.iteration + 1 > definition.data.maxIterations
                  ? state.iteration
                  : state.iteration + 1,
                phase: 'body',
              };
            }
            return { ...state, nodes };
          }
          case 'node-failed': {
            if (node === undefined || node.status !== 'in-flight') return state;
            if (node.inFlight !== event.payload.position) return state;
            const nodes = {
              ...state.nodes,
              [event.payload.nodeId]: nodeState('failed', node.attempts, null),
            };
            if (event.payload.code === 'ABORTED') {
              return {
                ...state,
                nodes,
                pauseReason: `Node "${event.payload.nodeId}" was aborted; the run pauses.`,
              };
            }
            if (seatOf(event.payload.nodeId)) {
              if (event.payload.code === 'ENGINE_UNAVAILABLE') {
                if (skippable.has(event.payload.nodeId)) {
                  return {
                    ...state,
                    nodes,
                    seats: {
                      ...state.seats,
                      [event.payload.nodeId]: {
                        ...state.seats[event.payload.nodeId]!,
                        outcome: 'skipped',
                        verdict: null,
                        findings: [],
                      },
                    },
                  };
                }
                return {
                  ...state,
                  nodes,
                  seats: {
                    ...state.seats,
                    [event.payload.nodeId]: {
                      ...state.seats[event.payload.nodeId]!,
                      outcome: 'non-verdict',
                    },
                  },
                  pauseReason: `Seat "${event.payload.nodeId}" has no available engine; the run pauses.`,
                };
              }
              return {
                ...state,
                nodes,
                seats: {
                  ...state.seats,
                  [event.payload.nodeId]: { ...state.seats[event.payload.nodeId]!, outcome: 'non-verdict' },
                },
              };
            }
            return { ...state, nodes };
          }
          case 'node-paused': {
            if (node === undefined || node.status !== 'in-flight') return state;
            if (node.inFlight !== event.payload.position) return state;
            return {
              ...state,
              nodes: {
                ...state.nodes,
                [event.payload.nodeId]: nodeState('paused', node.attempts, node.inFlight),
              },
            };
          }
          case 'node-resumed': {
            if (node === undefined || node.status !== 'paused') return state;
            return {
              ...state,
              nodes: {
                ...state.nodes,
                [event.payload.nodeId]: nodeState('in-flight', node.attempts, node.inFlight),
              },
            };
          }
          case 'seat-invalidated': {
            const seat = state.seats[event.payload.seatId];
            if (seat === undefined) return state;
            const nodeHere = state.nodes[event.payload.seatId]!;
            if (nodeHere.status === 'in-flight') {
              return {
                ...state,
                seats: {
                  ...state.seats,
                  [event.payload.seatId]: { ...seat, outcome: 'invalid', stale: true },
                },
              };
            }
            if (seat.outcome !== 'valid') return state;
            return {
              ...state,
              nodes: {
                ...state.nodes,
                [event.payload.seatId]: nodeState('pending', nodeHere.attempts, null),
              },
              seats: {
                ...state.seats,
                [event.payload.seatId]: {
                  ...seat,
                  outcome: 'invalid',
                  verdict: null,
                  confidence: null,
                  inputHashes: null,
                  workspaceFingerprint: null,
                  findings: [],
                },
              },
            };
          }
          case 'seat-skip': {
            const seat = state.seats[event.payload.seatId];
            if (seat === undefined || !skippable.has(event.payload.seatId)) return state;
            return {
              ...state,
              nodes: {
                ...state.nodes,
                [event.payload.seatId]: nodeState(
                  'failed',
                  state.nodes[event.payload.seatId]!.attempts,
                  null,
                ),
              },
              seats: {
                ...state.seats,
                [event.payload.seatId]: { ...seat, outcome: 'skipped', verdict: null, findings: [] },
              },
            };
          }
          case 'limit-paused': {
            return { ...state, pauseReason: event.payload.reason };
          }
          default:
            return state;
        }
      },
      decide(state) {
        const inFlightCount = Object.values(state.nodes)
          .filter((node) => node.status === 'in-flight').length;
        if (inFlightCount > 0) return [];

        if (state.pauseReason !== null) {
          return [{ kind: 'pause', reason: state.pauseReason }];
        }
        if (state.phase === 'settled') {
          const failed = definition.nodes.filter((node) =>
            state.nodes[node.id]!.status === 'failed' && !seatOf(node.id));
          if (failed.length > 0) {
            return [{
              kind: 'fail',
              code: 'CONVERGENCE_NODE_FAILED',
              message: `Failed nodes: ${failed.map((node) => node.id).join(', ')}.`,
            }];
          }
          return [{
            kind: 'fail',
            code: 'CONVERGENCE_EXHAUSTED',
            message: `Exhausted after ${state.iteration} iterations and ${state.restarts} repair rounds.`,
          }];
        }

        const dispatch = (nodeId: NodeId, prefix: string): GraphCommand => {
          const node = state.nodes[nodeId]!;
          return {
            kind: 'dispatch',
            nodeId,
            input: {
              positionSummary: `${prefix}, node ${nodeId}, attempt ${node.attempts + 1}`,
            },
            position: `${prefix}/${nodeId}/${node.attempts + 1}`,
          };
        };

        const pausedNode = definition.nodes.find(
          (node) => state.nodes[node.id]!.status === 'paused',
        );
        if (pausedNode !== undefined) {
          return [{
            kind: 'pause',
            reason: `Node "${pausedNode.id}" is paused; the run waits.`,
          }];
        }

        const failedLoopNode = [generator, evaluator, repair].find((id) => {
          const nodeStateHere = state.nodes[id]!;
          return nodeStateHere.status === 'failed'
            && nodeStateHere.attempts > definition.data.retryCapPerNode;
        });
        if (failedLoopNode !== undefined) {
          return [{
            kind: 'fail',
            code: 'CONVERGENCE_NODE_FAILED',
            message: `Failed nodes: ${failedLoopNode}.`,
          }];
        }

        if (state.phase === 'body') {
          const generatorState = state.nodes[generator]!;
          if (generatorState.status === 'in-flight') return [];
          if (generatorState.status === 'pending' || generatorState.status === 'failed') {
            return [dispatch(generator, `convergence/${state.iteration}`)];
          }
          const evaluatorState = state.nodes[evaluator]!;
          if (evaluatorState.status === 'in-flight') return [];
          if (evaluatorState.status === 'pending' || evaluatorState.status === 'failed') {
            return [dispatch(evaluator, `convergence/${state.iteration}`)];
          }
        }

        if (state.phase === 'review') {
          const fitting = seats.filter((id) => {
            const nodeState = state.nodes[id]!;
            if (nodeState.status !== 'pending' && nodeState.status !== 'failed') return false;
            if (nodeState.status === 'failed'
              && nodeState.attempts > definition.data.retryCapPerNode) return false;
            return state.seats[id]!.outcome === null
              || state.seats[id]!.outcome === 'invalid'
              || state.seats[id]!.outcome === 'non-verdict';
          });
          if (fitting.length > 0) {
            let free = definition.data.seatConcurrency
              - seats.filter((id) => state.nodes[id]!.status === 'in-flight').length;
            const commands: GraphCommand[] = [];
            for (const id of fitting) {
              if (free <= 0) break;
              commands.push(dispatch(id, `review/${state.iteration}`));
              free -= 1;
            }
            if (commands.length > 0) return commands;
          }
          if (quorumHolds(state)) {
            return [{
              kind: 'complete',
              output: {
                iterations: state.iteration,
                restarts: state.restarts,
                seats: Object.fromEntries(seats.map((id) => [
                  id,
                  state.seats[id]!.outcome === 'valid' && state.seats[id]!.verdict === 'pass'
                    ? 'accepted'
                    : state.seats[id]!.outcome ?? 'pending',
                ])),
              },
            }];
          }
          const findings = blockingFindings(state);
          if (findings.length > 0) {
            const escalated = findings.filter((finding) =>
              (state.findingRounds[finding.id] ?? 0) >= 3);
            if (escalated.length > 0) {
              return [{
                kind: 'fail',
                code: 'FINDING_ESCALATED',
                message: `Recurring findings: ${escalated.map((finding) => finding.id).join(', ')}.`,
              }];
            }
            if (state.restarts >= definition.data.maxReviewRestarts) {
              return [{
                kind: 'fail',
                code: 'CONVERGENCE_EXHAUSTED',
                message: `Exhausted after ${state.iteration} iterations and ${state.restarts} repair rounds.`,
              }];
            }
            const repairState = state.nodes[repair]!;
            if (repairState.status === 'pending' || repairState.status === 'failed') {
              return [{
                kind: 'dispatch',
                nodeId: repair,
                input: {
                  positionSummary: `repair round ${state.restarts + 1}`,
                  findings,
                },
                position: `convergence/repair/${state.restarts + 1}/${repairState.attempts + 1}`,
              }];
            }
          }
          const unresolved = seats.filter((id) => state.seats[id]!.outcome === null);
          if (unresolved.length > 0) {
            return [{
              kind: 'pause',
              reason: `Seats unresolved after retries: ${unresolved.join(', ')}.`,
            }];
          }
          return [{
            kind: 'fail',
            code: 'QUORUM_UNREACHABLE',
            message: `Only ${acceptedPasses(state).length} accepted passes; quorum is ${definition.data.quorum}.`,
          }];
        }

        return [];
      },
      describe(): GraphDescriptionInput {
        return {
          inputContract: { brief: 'json' },
          outputContract: { iterations: 'number', seats: 'object' },
          phases: [{
            id: 'convergence',
            name: 'Convergence',
            nodeIds: definition.nodes.map((node) => node.id),
          }],
          nodes: definition.nodes.map((node) => {
            const inputContract: JsonObject = node.data.role === 'seat'
              ? { draft: 'json' }
              : node.data.role === 'evaluator'
                ? { gate: 'json' }
                : { brief: 'json', critique: 'json?' };
            const outputContract: JsonObject = node.data.role === 'seat'
              ? {
                verdict: 'string',
                confidence: 'number',
                provider: 'string',
                modelFamily: 'string',
                inputHashes: 'object',
                workspaceFingerprint: 'string',
                findings: 'array?',
              }
              : { result: 'json' };
            return {
              id: node.id,
              phaseId: 'convergence',
              inputContract,
              outputContract,
              laneId: node.data.lane?.id ?? null,
            };
          }),
          policies: {
            retry: { capPerNode: definition.data.retryCapPerNode },
            stop: null,
            concurrency: { seats: definition.data.seatConcurrency },
            write: null,
            budget: null,
            action: null,
          },
          executionLanes: [...executionLanes.values()],
          requestedPermissions: [],
          bounds: {
            dispatches: {
              min: { kind: 'known', value: 2 + seats.length },
              max: {
                kind: 'known',
                value: (2 * (definition.data.maxIterations + definition.data.maxReviewRestarts)
                  + (definition.data.maxReviewRestarts + 1) * seats.length
                  + definition.data.maxReviewRestarts)
                  * (1 + definition.data.retryCapPerNode),
              },
            },
            maxConcurrency: { kind: 'known', value: definition.data.seatConcurrency },
            maxFanOut: { kind: 'known', value: definition.data.seatConcurrency },
          },
        };
      },
    };
  },
};
