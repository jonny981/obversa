import { createHash, randomUUID } from 'node:crypto';
import { validateArtifactReference, type ArtifactReference } from '../artifacts/store.js';
import { validateDomainEventEnvelope, type DomainEventEnvelope, type EventStreamRef, type StreamRevision } from '../events/envelope.js';
import { validateDomainEventBatch } from '../events/store.js';
import type { AgentResult, EngineFailureKind, EngineIncompleteResultEvidence, EngineSelectionRecord, UsageReceipt } from '../engines/engine.js';
import { LANE_DEAD_FAILURES } from '../engines/failure.js';
import type { ExecutionTarget, ResolvedExecutionLane, ResolvedPlan } from '../graph/plan.js';
import { canonicalJson, cloneFrozenJson, type JsonValue } from '../graph/value.js';
import { StorageError, type StorageErrorCode } from '../storage/error.js';
import { engineFailureExclusionKeys, isEngineExcluded, matchesEngineTarget, validateExecutionTarget, type EngineExclusionKey } from './engine-availability.js';
import { engineSelection, reportedUsage, validateAgentResult, validateIncompleteResultEvidence } from './result-parts.js';
import { loadRunDefinition, type RunStorageBinding } from './run-definition.js';

export interface PreflightPauseResult {
  readonly kind: 'pause';
  readonly code: 'PREFLIGHT_PAUSED';
  readonly reason: string;
  readonly preflightEventId: string;
}
export interface PreflightFailureResult {
  readonly kind: 'fail';
  readonly code: 'PREFLIGHT_FAILED';
  readonly message: string;
}
export interface RunPreflightState {
  readonly phase: 'disabled' | 'pending' | 'admitted' | 'paused' | 'failed';
  readonly pause: PreflightPauseResult | null;
  readonly resumedPreflightEventId: string | null;
  readonly unfinishedProbeEventId: string | null;
}
export type ProbeStartPayload = {
  readonly laneId: string;
  readonly target: ExecutionTarget;
  readonly selection: EngineSelectionRecord;
} & (
  | { readonly stage: 'static'; readonly contextNodeId: string | null; readonly expectedSelection: EngineSelectionRecord | null }
  | { readonly stage: 'live' }
);
export type ProbeEvidence =
  | { readonly kind: 'complete'; readonly result: Omit<AgentResult, 'raw'> }
  | { readonly kind: 'incomplete'; readonly result: Omit<EngineIncompleteResultEvidence, 'raw'> };
export interface ProbeEvidenceDocument {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly probeEventId: string;
  readonly evidence: ProbeEvidence;
}
export interface ProbeDiagnosticDocument {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly probeEventId: string;
  readonly detail: string;
}
type EvidenceReference = ArtifactReference<'preflight-evidence'>;
type DiagnosticReference = ArtifactReference<'preflight-diagnostic'>;
export type StaticOutcome =
  | { readonly kind: 'admitted'; readonly selection: EngineSelectionRecord }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'failed'; readonly failure: EngineFailureKind; readonly effective: EngineSelectionRecord | null; readonly diagnostic: DiagnosticReference }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'recording-failed'; readonly storageCode: StorageErrorCode };
export type LiveOutcome = { readonly usage: UsageReceipt; readonly effective: EngineSelectionRecord | null } & (
  | { readonly kind: 'succeeded'; readonly evidence: EvidenceReference; readonly diagnostic: DiagnosticReference }
  | { readonly kind: 'failed'; readonly failure: EngineFailureKind; readonly evidence: EvidenceReference | null; readonly diagnostic: DiagnosticReference }
  | { readonly kind: 'interrupted'; readonly evidence: null; readonly diagnostic: null }
  | { readonly kind: 'recording-failed'; readonly storageCode: StorageErrorCode; readonly evidence: null; readonly diagnostic: null }
);
export type ProbeFinishPayload = { readonly probeEventId: string } & (
  | { readonly stage: 'static'; readonly outcome: StaticOutcome }
  | { readonly stage: 'live'; readonly outcome: LiveOutcome }
);
type PauseReason = 'engine-failure' | 'interrupted' | 'recording-failure';
export interface PreflightPausedPayload {
  readonly finishedProbeEventId: string;
  readonly reason: PauseReason;
}
export interface PreflightResumedPayload { readonly preflightEventId: string }
export interface PreflightFailedPayload {
  readonly laneId: string;
  readonly code: 'PREFLIGHT_FAILED';
  readonly reason: 'no-admissible-target';
}
export interface ProbeModelUnavailableFact {
  readonly schemaVersion: 1;
  readonly source: { readonly kind: 'preflight'; readonly probeEventId: string; readonly laneId: string };
  readonly target: ExecutionTarget;
  readonly selection: EngineSelectionRecord;
  readonly effective: EngineSelectionRecord;
  readonly failure: EngineFailureKind;
}
export interface RecordedProbeStart {
  readonly envelope: DomainEventEnvelope;
  readonly payload: ProbeStartPayload;
}
export interface CompletedProbe {
  readonly start: RecordedProbeStart;
  readonly finish: DomainEventEnvelope;
  readonly payload: ProbeFinishPayload;
  readonly evidence: ProbeEvidence | null;
}
export interface ValidatedProbeFailure {
  readonly envelope: DomainEventEnvelope;
  readonly fact: ProbeModelUnavailableFact;
  readonly exclusionKeys: readonly EngineExclusionKey[];
}
export interface LoadedRunPreflight {
  readonly stream: EventStreamRef;
  readonly revision: StreamRevision;
  readonly events: readonly DomainEventEnvelope[];
  readonly state: RunPreflightState;
  readonly probes: readonly CompletedProbe[];
  readonly openProbe: RecordedProbeStart | null;
  readonly admissionCompletedAtRevision: StreamRevision | null;
  readonly probeFailures: ReadonlyMap<string, ValidatedProbeFailure>;
}

const failureKinds: ReadonlySet<string> = new Set<EngineFailureKind>([
  'auth', 'billing', 'missing-cli', 'model-unavailable', 'invalid-config', 'rate-limit',
  'quota', 'transient', 'timeout', 'aborted', 'unknown',
]);
const storageCodes: ReadonlySet<string> = new Set<StorageErrorCode>([
  'INVALID_STORED_VALUE', 'UNSUPPORTED_ENVELOPE_VERSION', 'REVISION_CONFLICT',
  'DUPLICATE_EVENT_ID', 'CORRUPT_EVENT_STREAM', 'ARTIFACT_NOT_FOUND', 'ARTIFACT_NOT_ADMITTED',
  'ARTIFACT_INTEGRITY', 'STORAGE_LIMIT_EXCEEDED', 'SENSITIVE_CONTENT', 'KNOWN_SECRET', 'UNSAFE_STORAGE_PATH',
]);
function invalid(path: string, message: string): never {
  throw new StorageError('INVALID_STORED_VALUE', message, { path });
}
function checked<T>(path: string, operation: () => T): T {
  try { return operation(); } catch { return invalid(path, 'Stored preflight value is invalid.'); }
}
function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'Expected a preflight object.');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: readonly string[], path: string, optional: readonly string[] = []): void {
  for (const field of fields) if (!Object.hasOwn(value, field)) invalid(`${path}/${field}`, 'Required preflight field is missing.');
  for (const field of Object.keys(value)) if (!fields.includes(field) && !optional.includes(field)) invalid(`${path}/${field}`, 'Unknown preflight field.');
}
function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)) invalid(path, 'Invalid preflight identifier.');
  return value;
}
function frozen<T>(value: T): T {
  return cloneFrozenJson(value as unknown as JsonValue) as unknown as T;
}
function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue);
}
function selection(value: unknown, path: string): EngineSelectionRecord {
  const item = object(value, path);
  exact(item, ['adapter', 'adapterVersion', 'provider', 'modelFamily', 'model', 'executable', 'capabilities'], path);
  const result = checked(path, () => engineSelection(item as unknown as EngineSelectionRecord));
  if (!same(item, result)) invalid(path, 'Selection normalization would change stored identity.');
  return result;
}
function usage(value: unknown, path: string): UsageReceipt {
  const item = object(value, path);
  if (item.kind === 'unknown') {
    exact(item, ['kind'], path);
    return Object.freeze({ kind: 'unknown' });
  }
  if (item.kind !== 'reported') invalid(path, 'Invalid usage receipt kind.');
  exact(item, ['kind', 'inputTokens', 'outputTokens'], path, ['cacheCreationInputTokens', 'cacheReadInputTokens']);
  return checked(path, () => reportedUsage(item as unknown as Parameters<typeof reportedUsage>[0]));
}
function failure(value: unknown, path: string): EngineFailureKind {
  if (typeof value !== 'string' || !failureKinds.has(value)) invalid(path, 'Invalid engine failure kind.');
  return value as EngineFailureKind;
}
function storageCode(value: unknown, path: string): StorageErrorCode {
  if (typeof value !== 'string' || !storageCodes.has(value)) invalid(path, 'Invalid storage error code.');
  return value as StorageErrorCode;
}
function resultEvidence(value: unknown, path: string): ProbeEvidence {
  const item = object(value, path);
  exact(item, ['kind', 'result'], path);
  if (item.kind !== 'complete' && item.kind !== 'incomplete') invalid(`${path}/kind`, 'Invalid evidence kind.');
  const result = object(item.result, `${path}/result`);
  exact(result, ['parts', 'usage', 'requested', 'effective'], `${path}/result`, ['stopReason', 'transportFailure']);
  if (!Array.isArray(result.parts)) invalid(`${path}/result/parts`, 'Result parts must be an array.');
  result.parts.forEach((value, index) => {
    const partPath = `${path}/result/parts/${index}`;
    const part = object(value, partPath);
    if (part.kind === 'assistant') exact(part, ['kind', 'text', 'final'], partPath);
    else if (part.kind === 'structured') exact(part, ['kind', 'value', 'final'], partPath);
    else invalid(partPath, 'Invalid result part kind.');
  });
  usage(result.usage, `${path}/result/usage`);
  selection(result.requested, `${path}/result/requested`);
  selection(result.effective, `${path}/result/effective`);
  if (Object.hasOwn(result, 'transportFailure')) {
    exact(object(result.transportFailure, `${path}/result/transportFailure`), ['kind', 'message', 'exitCode'], `${path}/result/transportFailure`);
  }
  const validated = checked(`${path}/result`, () => item.kind === 'complete'
    ? validateAgentResult(result as unknown as AgentResult)
    : validateIncompleteResultEvidence(result as unknown as EngineIncompleteResultEvidence));
  return frozen({ kind: item.kind, result: validated }) as ProbeEvidence;
}
function reference<Purpose extends string>(value: unknown, purpose: Purpose, path: string): ArtifactReference<Purpose> {
  const result = validateArtifactReference(value);
  if (result.purpose !== purpose || result.mediaType !== 'application/json') invalid(path, 'Preflight artifact has the wrong purpose or media type.');
  return result as ArtifactReference<Purpose>;
}
async function document(
  storage: RunStorageBinding, runId: string, probeEventId: string,
  reference: ArtifactReference, field: 'evidence' | 'detail',
): Promise<unknown> {
  const path = `/events/${probeEventId}/${field}`;
  const bytes = await storage.artifactStore.read({ namespace: storage.record.namespace, runId }, reference);
  if (bytes.byteLength !== reference.byteLength
    || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== reference.digest) {
    throw new StorageError('ARTIFACT_INTEGRITY', 'Preflight artifact bytes do not match their reference.', { path });
  }
  const parsed = checked(path, () => cloneFrozenJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as JsonValue));
  const item = object(parsed, path);
  exact(item, ['schemaVersion', 'runId', 'probeEventId', field], path);
  if (item.schemaVersion !== 1 || item.runId !== runId || item.probeEventId !== probeEventId) invalid(path, 'Preflight artifact belongs to a different call, run or version.');
  if (field === 'detail' && typeof item.detail !== 'string') invalid(path, 'Preflight diagnostic detail must be a string.');
  return item[field];
}
function routeKey(laneId: string, target: ExecutionTarget): string {
  return canonicalJson([laneId, target] as unknown as JsonValue);
}
function checkKey(start: ProbeStartPayload): string {
  return canonicalJson([start.laneId, start.target, start.stage, start.stage === 'static' ? start.contextNodeId : null] as unknown as JsonValue);
}
function contexts(plan: ResolvedPlan, laneId: string): readonly (string | null)[] {
  const ids = plan.nodes.filter((node) => node.laneId === laneId).map((node) => node.id);
  return ids.length === 0 ? [null] : ids;
}
function targets(lane: ResolvedExecutionLane): readonly ExecutionTarget[] {
  return [lane.effective, ...lane.fallbacks];
}
function startPayload(value: unknown, plan: ResolvedPlan, path: string): ProbeStartPayload {
  const item = object(value, path);
  if (item.stage !== 'static' && item.stage !== 'live') invalid(`${path}/stage`, 'Invalid probe stage.');
  exact(item, ['laneId', 'target', 'selection', 'stage', ...(item.stage === 'static' ? ['contextNodeId', 'expectedSelection'] : [])], path);
  const laneId = text(item.laneId, `${path}/laneId`);
  const lane = plan.executionLanes.find((candidate) => candidate.id === laneId);
  if (lane === undefined) invalid(`${path}/laneId`, 'Unknown preflight lane.');
  const target = checked(`${path}/target`, () => validateExecutionTarget(item.target as ExecutionTarget));
  if (!targets(lane).some((candidate) => same(candidate, target))) invalid(`${path}/target`, 'Probe target is outside its declared lane.');
  const selected = selection(item.selection, `${path}/selection`);
  if (!matchesEngineTarget(target, selected)) invalid(`${path}/selection`, 'Normal selection does not match its declared target.');
  if (item.stage === 'static') {
    const contextNodeId = item.contextNodeId === null ? null : text(item.contextNodeId, `${path}/contextNodeId`);
    if (!contexts(plan, laneId).includes(contextNodeId)) invalid(`${path}/contextNodeId`, 'Static context is not a real node of this lane.');
    return frozen({ laneId, target, selection: selected, stage: 'static', contextNodeId,
      expectedSelection: item.expectedSelection === null ? null : selection(item.expectedSelection, `${path}/expectedSelection`) });
  }
  return frozen({ laneId, target, selection: selected, stage: 'live' });
}
async function completeProbe(
  storage: RunStorageBinding, runId: string, start: RecordedProbeStart, envelope: DomainEventEnvelope,
  admittedSelection: EngineSelectionRecord | null,
): Promise<CompletedProbe> {
  const path = `/events/${envelope.eventId}`;
  const item = object(envelope.payload, path);
  exact(item, ['probeEventId', 'stage', 'outcome'], path);
  if (item.probeEventId !== start.envelope.eventId || item.stage !== start.payload.stage
    || envelope.causationId !== start.envelope.eventId) invalid(path, 'Finish must close its one matching start.');
  const outcome = object(item.outcome, `${path}/outcome`);
  let evidence: ProbeEvidence | null = null;
  if (item.stage === 'static') {
    if (outcome.kind === 'admitted') {
      exact(outcome, ['kind', 'selection'], path);
      const admitted = selection(outcome.selection, path);
      if (!matchesEngineTarget(start.payload.target, admitted)) invalid(path, 'Admitted identity does not match the normal target.');
      const expected = start.payload.stage === 'static' ? start.payload.expectedSelection : null;
      if (expected !== null && !same(expected, admitted)) invalid(path, 'Restoration changed the saved admitted identity.');
    } else if (outcome.kind === 'unsupported' || outcome.kind === 'interrupted') {
      exact(outcome, ['kind'], path);
    } else if (outcome.kind === 'recording-failed') {
      exact(outcome, ['kind', 'storageCode'], path);
      storageCode(outcome.storageCode, path);
    } else if (outcome.kind === 'failed') {
      exact(outcome, ['kind', 'failure', 'effective', 'diagnostic'], path);
      failure(outcome.failure, path);
      if (outcome.effective !== null) selection(outcome.effective, path);
      await document(storage, runId, start.envelope.eventId, reference(outcome.diagnostic, 'preflight-diagnostic', path), 'detail');
    } else invalid(path, 'Invalid static outcome.');
  } else {
    const base = ['kind', 'usage', 'effective', 'evidence', 'diagnostic'];
    if (outcome.kind === 'succeeded' || outcome.kind === 'interrupted') exact(outcome, base, path);
    else if (outcome.kind === 'failed') { exact(outcome, [...base, 'failure'], path); failure(outcome.failure, path); }
    else if (outcome.kind === 'recording-failed') { exact(outcome, [...base, 'storageCode'], path); storageCode(outcome.storageCode, path); }
    else invalid(path, 'Invalid live outcome.');
    const receipt = usage(outcome.usage, path);
    const effective = outcome.effective === null ? null : selection(outcome.effective, path);
    if (outcome.kind === 'interrupted' || outcome.kind === 'recording-failed') {
      if (outcome.evidence !== null || outcome.diagnostic !== null) invalid(path, 'Interrupted or unrecordable evidence cannot carry artifact references.');
      if (outcome.kind === 'interrupted' && (receipt.kind !== 'unknown' || effective !== null)) invalid(path, 'Interrupted live usage and effective identity must be unknown.');
    } else {
      await document(storage, runId, start.envelope.eventId, reference(outcome.diagnostic, 'preflight-diagnostic', path), 'detail');
      if (outcome.evidence !== null) {
        const raw = await document(storage, runId, start.envelope.eventId, reference(outcome.evidence, 'preflight-evidence', path), 'evidence');
        evidence = resultEvidence(raw, `${path}/evidence`);
        if (!same(receipt, evidence.result.usage) || !same(effective, evidence.result.effective)) invalid(path, 'Event metadata must retain terminal evidence usage and identity.');
      }
      if (outcome.kind === 'succeeded') {
        if (evidence?.kind !== 'complete' || !evidence.result.parts.some((part) => part.kind === 'assistant' && part.final)) invalid(path, 'Live success needs complete final assistant evidence.');
        const requestedMatches = evidence.result.requested.capabilities.length === 0 && (admittedSelection === null
          ? evidence.result.requested.adapter === start.payload.selection.adapter
            && evidence.result.requested.provider === start.payload.selection.provider
            && evidence.result.requested.modelFamily === start.payload.selection.modelFamily
            && evidence.result.requested.model === start.payload.selection.model
          : same(evidence.result.requested, engineSelection({ ...admittedSelection, capabilities: [] })));
        if (!requestedMatches) invalid(path, 'Live requested identity does not match the tool-free admitted selection.');
      } else if (evidence !== null && !['unknown', 'timeout', 'aborted'].includes(outcome.failure as string)) {
        invalid(path, 'Complete or incomplete failed evidence cannot justify a lasting exclusion.');
      }
    }
  }
  return Object.freeze({ start, finish: envelope, payload: frozen(item) as unknown as ProbeFinishPayload, evidence });
}
function claimsProbeFailure(envelope: DomainEventEnvelope): boolean {
  if (envelope.type !== 'graph:model-unavailable') return false;
  const payload = envelope.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const source = (payload as Record<string, JsonValue>).source;
  return source !== null && typeof source === 'object' && !Array.isArray(source)
    && (source as Record<string, JsonValue>).kind === 'preflight';
}
function probeFailure(
  envelope: DomainEventEnvelope, completed: CompletedProbe, declaredTargets: readonly ExecutionTarget[],
): ValidatedProbeFailure {
  const path = `/events/${envelope.eventId}`;
  const item = object(envelope.payload, path);
  exact(item, ['schemaVersion', 'source', 'target', 'selection', 'effective', 'failure'], path);
  const source = object(item.source, `${path}/source`);
  exact(source, ['kind', 'probeEventId', 'laneId'], `${path}/source`);
  const start = completed.start.payload;
  const outcome = completed.payload.outcome;
  if (item.schemaVersion !== 1 || source.kind !== 'preflight' || source.probeEventId !== completed.start.envelope.eventId
    || source.laneId !== start.laneId || envelope.causationId !== completed.finish.eventId
    || outcome.kind !== 'failed' || item.failure !== outcome.failure) invalid(path, 'Probe exclusion does not match its failed check.');
  const selected = selection(item.selection, path);
  const effective = selection(item.effective, path);
  const target = checked(path, () => validateExecutionTarget(item.target as ExecutionTarget));
  if (!same(target, start.target) || !same(selected, start.selection)
    || !same(effective, outcome.effective ?? start.selection)) invalid(path, 'Probe exclusion changed its declared or observed identity.');
  const isLive = completed.payload.stage === 'live';
  const temporarySelected = isLive ? engineSelection({ ...selected, capabilities: [] }) : selected;
  const keys = engineFailureExclusionKeys({
    selection: temporarySelected,
    effective: outcome.effective ?? temporarySelected,
    failure: outcome.failure,
    target: isLive ? { ...target, tools: [] } : target,
  }, isLive ? declaredTargets.map((value) => ({ ...value, tools: [] })) : declaredTargets);
  if (keys.length === 0) invalid(path, 'A nonlasting failure cannot have an exclusion fact.');
  return Object.freeze({ envelope, fact: frozen(item) as unknown as ProbeModelUnavailableFact, exclusionKeys: Object.freeze([...keys]) });
}
function pauseResult(eventId: string, reason: PauseReason): PreflightPauseResult {
  const message = reason === 'interrupted' ? 'Preflight was interrupted; resume this pause explicitly.'
    : reason === 'recording-failure' ? 'Preflight evidence could not be stored; resume this pause explicitly.'
    : 'Preflight did not complete; resume this pause explicitly.';
  return Object.freeze({ kind: 'pause', code: 'PREFLIGHT_PAUSED', reason: message, preflightEventId: eventId });
}

/** Private package surface: the executor replays these captured envelopes. */
export async function loadRunPreflight(storage: RunStorageBinding, runId: string): Promise<LoadedRunPreflight> {
  const definition = await loadRunDefinition(storage, runId);
  const stream = Object.freeze({ namespace: storage.record.namespace, streamId: runId });
  const events: DomainEventEnvelope[] = [];
  const eventIds = new Set<string>();
  for await (const value of storage.eventStore.read(stream)) {
    const envelope = validateDomainEventEnvelope(value);
    if (envelope.streamId !== runId || envelope.revision !== events.length + 1 || eventIds.has(envelope.eventId)) invalid('/events', 'Run stream identity, revision or event ID changed.');
    events.push(envelope);
    eventIds.add(envelope.eventId);
  }
  if (events.length === 0 || !same(events[0], definition.record)) invalid('/events/0', 'Captured run start differs from the loaded definition.');
  const plan = definition.resolvedPlan.plan;
  const policy = plan.preflight;
  const probes: CompletedProbe[] = [];
  const latest = new Map<string, CompletedProbe>();
  const saved = new Map<string, EngineSelectionRecord>();
  const probeFailures = new Map<string, ValidatedProbeFailure>();
  const excluded = new Set<EngineExclusionKey>();
  let openProbe: RecordedProbeStart | null = null;
  let pause: PreflightPauseResult | null = null;
  let resumedPreflightEventId: string | null = null;
  let resumedEvent: DomainEventEnvelope | null = null;
  let admissionCompletedAtRevision: number | null = null;
  let failed = false;
  let requiredNext: { kind: 'pause' | 'exclusion'; probe: CompletedProbe; reason: PauseReason } | null = null;
  const lanePolicy = (laneId: string) => policy!.lanes.find((lane) => lane.laneId === laneId)!;
  const normalSelection = (target: ExecutionTarget) => engineSelection({
    adapter: target.adapter, provider: target.provider, modelFamily: target.modelFamily,
    model: target.model, capabilities: target.tools,
  });
  const staticChecks = (laneId: string, target: ExecutionTarget) => contexts(plan, laneId).map((contextNodeId) => latest.get(checkKey({
    laneId, target, selection: normalSelection(target), stage: 'static', contextNodeId, expectedSelection: null,
  })));
  const unavailable = (lane: ResolvedExecutionLane, target: ExecutionTarget) => isEngineExcluded(excluded, normalSelection(target), target, targets(lane));
  const staticallyEligible = (lane: ResolvedExecutionLane, target: ExecutionTarget) => !unavailable(lane, target)
    && staticChecks(lane.id, target).every((probe) => probe !== undefined && (probe.payload.outcome.kind === 'admitted'
      || (probe.payload.outcome.kind === 'unsupported' && lanePolicy(lane.id).unsupportedStatic === 'allow')));
  const covered = () => plan.executionLanes.every((lane) => targets(lane).every((target) => staticChecks(lane.id, target).every((probe) => probe !== undefined)));
  const ready = () => covered() && plan.executionLanes.every((lane) => targets(lane).some((target) =>
    staticallyEligible(lane, target) && (lanePolicy(lane.id).live === 'skip' || probes.some((probe) =>
      probe.start.payload.laneId === lane.id && same(probe.start.payload.target, target)
      && probe.payload.stage === 'live' && probe.payload.outcome.kind === 'succeeded'))));
  const allDead = (lane: ResolvedExecutionLane) => targets(lane).every((target) => unavailable(lane, target)
    || (lanePolicy(lane.id).unsupportedStatic === 'block' && staticChecks(lane.id, target).some((probe) => probe?.payload.outcome.kind === 'unsupported')));
  if (policy !== undefined && ready()) admissionCompletedAtRevision = 1;

  for (const envelope of events.slice(1)) {
    const isProbeFact = claimsProbeFailure(envelope);
    const isPreflight = envelope.type.startsWith('preflight:');
    if (requiredNext !== null && envelope.type !== (requiredNext.kind === 'pause' ? 'preflight:paused' : 'graph:model-unavailable')) invalid(`/events/${envelope.eventId}`, 'A failed finish must be followed by its atomic pause or exclusion.');
    if (!isPreflight && !isProbeFact) {
      if (requiredNext !== null) invalid(`/events/${envelope.eventId}`, 'A probe exclusion source is missing.');
      continue;
    }
    const path = `/events/${envelope.eventId}`;
    if (policy === undefined || failed) invalid(path, 'Preflight records are not allowed without policy or after terminal failure.');
    if (envelope.version !== 1 || envelope.correlationId !== runId) invalid(path, 'Preflight version or run identity is invalid.');
    if (isProbeFact) {
      if (requiredNext?.kind !== 'exclusion') invalid(path, 'Probe exclusion has no unmatched failed finish.');
      const lane = plan.executionLanes.find((candidate) => candidate.id === requiredNext!.probe.start.payload.laneId)!;
      const validated = probeFailure(envelope, requiredNext.probe, targets(lane));
      probeFailures.set(envelope.eventId, validated);
      for (const key of validated.exclusionKeys) excluded.add(key);
      requiredNext = null;
    } else if (envelope.type === 'preflight:probe-started') {
      if (openProbe !== null || pause !== null || requiredNext !== null) invalid(path, 'A probe cannot start while another check or pause is open.');
      if (envelope.causationId !== (resumedEvent?.eventId ?? null)) invalid(path, 'A new probe must name its consumed resume event, or have no cause.');
      const payload = startPayload(envelope.payload, plan, path);
      const key = checkKey(payload);
      const previous = latest.get(key);
      if (previous !== undefined && ['failed', 'interrupted', 'recording-failed'].includes(previous.payload.outcome.kind)
        && (resumedEvent === null || resumedEvent.revision <= previous.finish.revision)) invalid(path, 'Retrying failed or interrupted work requires a new explicit resume.');
      const prior = saved.get(routeKey(payload.laneId, payload.target));
      if (payload.stage === 'static') {
        if (!same(payload.expectedSelection, prior ?? null)) invalid(path, 'Static restoration must use the saved identity exactly.');
      } else {
        const lane = plan.executionLanes.find((candidate) => candidate.id === payload.laneId)!;
        const successes = probes.filter((probe) => probe.start.payload.laneId === payload.laneId
          && probe.payload.stage === 'live' && probe.payload.outcome.kind === 'succeeded');
        const targetAlreadyAnswered = successes.some((probe) => same(probe.start.payload.target, payload.target));
        const laneHasEligibleAnswer = successes.some((probe) => staticallyEligible(lane, probe.start.payload.target));
        if (admissionCompletedAtRevision !== null || targetAlreadyAnswered || laneHasEligibleAnswer || !covered()
          || lanePolicy(payload.laneId).live !== 'required'
          || !staticallyEligible(lane, payload.target)) invalid(path, 'This live probe is not permitted by its static records and policy.');
        if (prior !== undefined && !same(payload.selection, prior)) invalid(path, 'Live start must retain its admitted normal identity.');
      }
      openProbe = Object.freeze({ envelope, payload });
    } else if (envelope.type === 'preflight:probe-finished') {
      if (openProbe === null || pause !== null || requiredNext !== null) invalid(path, 'Probe finish has no unmatched start.');
      const completed = await completeProbe(
        storage,
        runId,
        openProbe,
        envelope,
        saved.get(routeKey(openProbe.payload.laneId, openProbe.payload.target)) ?? null,
      );
      probes.push(completed);
      latest.set(checkKey(openProbe.payload), completed);
      const outcome = completed.payload.outcome;
      if (outcome.kind === 'admitted') saved.set(routeKey(openProbe.payload.laneId, openProbe.payload.target), outcome.selection);
      if (outcome.kind === 'failed') requiredNext = { kind: LANE_DEAD_FAILURES.has(outcome.failure) ? 'exclusion' : 'pause', probe: completed, reason: 'engine-failure' };
      if (outcome.kind === 'interrupted' || outcome.kind === 'recording-failed') requiredNext = { kind: 'pause', probe: completed, reason: outcome.kind === 'interrupted' ? 'interrupted' : 'recording-failure' };
      openProbe = null;
    } else if (envelope.type === 'preflight:paused') {
      const item = object(envelope.payload, path);
      exact(item, ['finishedProbeEventId', 'reason'], path);
      if (pause !== null || openProbe !== null || requiredNext?.kind !== 'pause'
        || item.finishedProbeEventId !== requiredNext.probe.finish.eventId
        || item.reason !== requiredNext.reason || envelope.causationId !== requiredNext.probe.finish.eventId) invalid(path, 'Pause does not match its just-finished failed check.');
      pause = pauseResult(envelope.eventId, requiredNext.reason);
      requiredNext = null;
    } else if (envelope.type === 'preflight:resumed') {
      const item = object(envelope.payload, path);
      exact(item, ['preflightEventId'], path);
      if (pause === null || openProbe !== null || requiredNext !== null
        || item.preflightEventId !== pause.preflightEventId || envelope.causationId !== pause.preflightEventId) invalid(path, 'Resume must consume the exact current pause once.');
      resumedPreflightEventId = pause.preflightEventId;
      resumedEvent = envelope;
      pause = null;
    } else if (envelope.type === 'preflight:failed') {
      const item = object(envelope.payload, path);
      exact(item, ['laneId', 'code', 'reason'], path);
      const lane = plan.executionLanes.find((candidate) => candidate.id === item.laneId);
      if (pause !== null || openProbe !== null || requiredNext !== null || lane === undefined
        || item.code !== 'PREFLIGHT_FAILED' || item.reason !== 'no-admissible-target' || !allDead(lane)) invalid(path, 'Terminal preflight failure needs a lane with no admissible target.');
      if (envelope.causationId !== null && !probes.some((probe) => probe.finish.eventId === envelope.causationId && probe.start.payload.laneId === lane.id)) invalid(path, 'Terminal failure cause is not a completed check in its lane.');
      failed = true;
    } else invalid(path, 'Unknown preflight event type.');
    if (admissionCompletedAtRevision === null && !failed && openProbe === null && pause === null && requiredNext === null && ready()) admissionCompletedAtRevision = envelope.revision;
  }
  if (requiredNext !== null) invalid('/events', 'A failed finish is missing its atomic pause or exclusion.');
  const state: RunPreflightState = Object.freeze({
    phase: policy === undefined ? 'disabled' : failed ? 'failed' : pause !== null ? 'paused'
      : openProbe !== null || admissionCompletedAtRevision === null ? 'pending' : 'admitted',
    pause, resumedPreflightEventId, unfinishedProbeEventId: openProbe?.envelope.eventId ?? null,
  });
  return Object.freeze({ stream, revision: events.at(-1)!.revision, events: Object.freeze(events), state,
    probes: Object.freeze(probes), openProbe, admissionCompletedAtRevision, probeFailures });
}

/** Read admission state without calling engines, loading a host, or appending events. */
export async function readRunPreflight(storage: RunStorageBinding, runId: string): Promise<RunPreflightState> {
  return (await loadRunPreflight(storage, runId)).state;
}

/**
 * The caller must own this run and verify worker cleanup before calling.
 * Close one uncertain check using one expected-revision append; never retry.
 */
export async function interruptRunPreflight(storage: RunStorageBinding, runId: string): Promise<PreflightPauseResult | null> {
  const loaded = await loadRunPreflight(storage, runId);
  if (loaded.state.pause !== null) return loaded.state.pause;
  if (loaded.openProbe === null) return null;
  const probe = loaded.openProbe;
  const finishId = randomUUID();
  const pauseId = randomUUID();
  const timestamp = new Date().toISOString();
  const outcome: StaticOutcome | LiveOutcome = probe.payload.stage === 'static' ? { kind: 'interrupted' } : {
    kind: 'interrupted', usage: { kind: 'unknown' }, effective: null, evidence: null, diagnostic: null,
  };
  const events = validateDomainEventBatch([
    { eventId: finishId, type: 'preflight:probe-finished', version: 1, timestamp, correlationId: runId,
      causationId: probe.envelope.eventId, payload: { probeEventId: probe.envelope.eventId, stage: probe.payload.stage, outcome } },
    { eventId: pauseId, type: 'preflight:paused', version: 1, timestamp, correlationId: runId,
      causationId: finishId, payload: { finishedProbeEventId: finishId, reason: 'interrupted' } },
  ]);
  await storage.eventStore.append(loaded.stream, loaded.revision, events);
  return pauseResult(pauseId, 'interrupted');
}
