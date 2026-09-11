import type { EngineSelectionRecord } from '../engines/engine.js';
import type { EngineFailureKind } from '../engines/failure.js';
import type { ExecutionTarget } from '../graph/plan.js';
import { canonicalJson, cloneFrozenJson, type JsonValue } from '../graph/value.js';

export type EngineExclusionKey =
  | `adapter:${string}`
  | `adapter-provider:${string}`
  | `provider-model:${string}`;

export interface EngineFailureIdentity {
  readonly selection: EngineSelectionRecord;
  readonly effective: EngineSelectionRecord;
  readonly failure: EngineFailureKind;
  readonly target?: ExecutionTarget;
}

export class EngineIdentityUnresolvedError extends Error {
  readonly code = 'ENGINE_IDENTITY_UNRESOLVED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'EngineIdentityUnresolvedError';
  }
}

export function validateExecutionTarget(value: ExecutionTarget): ExecutionTarget {
  const raw = cloneFrozenJson(value as unknown as JsonValue);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('An execution target must be an object.');
  }
  const object = raw as Readonly<Record<string, JsonValue>>;
  const fields = ['adapter', 'provider', 'modelFamily', 'model', 'tools'];
  if (canonicalJson(Object.keys(raw).sort()) !== canonicalJson(fields.sort())) {
    throw new TypeError('An execution target must have exactly its five routing fields.');
  }
  for (const field of ['adapter', 'provider', 'modelFamily', 'model']) {
    const text = object[field];
    if (typeof text !== 'string' || text.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(text)) {
      throw new TypeError(`Execution target ${field} must be a non-empty string without control characters.`);
    }
  }
  if (!Array.isArray(object.tools)
    || object.tools.some((tool: JsonValue) => typeof tool !== 'string' || tool.trim().length === 0
      || /[\u0000-\u001f\u007f]/u.test(tool))
    || new Set(object.tools).size !== object.tools.length) {
    throw new TypeError('Execution target tools must be unique non-empty strings.');
  }
  return raw as unknown as ExecutionTarget;
}

export function matchesEngineTarget(
  target: ExecutionTarget,
  selection: EngineSelectionRecord,
): boolean {
  return target.adapter === selection.adapter
    && (selection.provider === null || target.provider === selection.provider)
    && (selection.modelFamily === null || target.modelFamily === selection.modelFamily)
    && target.model === selection.model
    && canonicalJson(target.tools) === canonicalJson(selection.capabilities);
}

function adapterKey(adapter: string): EngineExclusionKey {
  return `adapter:${canonicalJson([adapter])}`;
}

function adapterProviderKey(adapter: string, provider: string): EngineExclusionKey {
  return `adapter-provider:${canonicalJson([adapter, provider])}`;
}

function hasAdapterProviderKey(
  unavailable: ReadonlySet<EngineExclusionKey>,
  adapter: string,
): boolean {
  const prefix = `adapter-provider:${canonicalJson([adapter]).slice(0, -1)},`;
  return [...unavailable].some((key) => key.startsWith(prefix));
}

function providerModelKey(provider: string, model: string): EngineExclusionKey {
  return `provider-model:${canonicalJson([provider, model])}`;
}

function resolveAdapterProvider(
  selection: EngineSelectionRecord,
  declaredTargets: readonly ExecutionTarget[],
): EngineExclusionKey {
  if (selection.provider !== null) {
    return adapterProviderKey(selection.adapter, selection.provider);
  }
  const keys = new Set(declaredTargets
    .filter((target) => matchesEngineTarget(target, selection))
    .map((target) => adapterProviderKey(target.adapter, target.provider)));
  if (keys.size !== 1) {
    throw new EngineIdentityUnresolvedError(
      `Cannot resolve ${selection.adapter}/${selection.model ?? '(unknown model)'} to one declared adapter/provider; matches: ${canonicalJson([...keys].sort())}.`,
    );
  }
  return keys.values().next().value!;
}

function resolveProviderModel(
  selection: EngineSelectionRecord,
  declaredTargets: readonly ExecutionTarget[],
): EngineExclusionKey {
  if (selection.provider !== null && selection.model !== null) {
    return providerModelKey(selection.provider, selection.model);
  }
  const keys = new Set(declaredTargets
    .filter((target) => matchesEngineTarget(target, selection))
    .map((target) => providerModelKey(target.provider, target.model)));
  if (keys.size !== 1) {
    throw new EngineIdentityUnresolvedError(
      `Cannot resolve ${selection.adapter}/${selection.model ?? '(unknown model)'} to one declared provider/model; matches: ${canonicalJson([...keys].sort())}.`,
    );
  }
  return keys.values().next().value!;
}

function effectiveMatchesSelectedRoute(
  selected: EngineSelectionRecord,
  effective: EngineSelectionRecord,
  target: ExecutionTarget | undefined,
): boolean {
  if (target !== undefined) return matchesEngineTarget(target, effective);
  return effective.adapter === selected.adapter
    && effective.model === selected.model
    && (effective.provider === null || effective.provider === selected.provider)
    && (effective.modelFamily === null || effective.modelFamily === selected.modelFamily)
    && canonicalJson(effective.capabilities) === canonicalJson(selected.capabilities);
}

export function engineFailureExclusionKeys(
  fact: EngineFailureIdentity,
  declaredTargets: readonly ExecutionTarget[],
): readonly EngineExclusionKey[] {
  switch (fact.failure) {
    case 'missing-cli':
    case 'invalid-config':
      return [adapterKey(fact.selection.adapter)];
    case 'auth':
      return [fact.target === undefined
        ? resolveAdapterProvider(fact.selection, declaredTargets)
        : adapterProviderKey(fact.target.adapter, fact.target.provider)];
    case 'model-unavailable':
    case 'billing':
    case 'quota': {
      const selected = fact.target === undefined
        ? resolveProviderModel(fact.selection, declaredTargets)
        : providerModelKey(fact.target.provider, fact.target.model);
      const effective = effectiveMatchesSelectedRoute(fact.selection, fact.effective, fact.target)
        ? selected
        : resolveProviderModel(fact.effective, declaredTargets);
      return [...new Set([selected, effective])];
    }
    default:
      return [];
  }
}

export function isEngineExcluded(
  unavailable: ReadonlySet<EngineExclusionKey>,
  selection: EngineSelectionRecord,
  target: ExecutionTarget | undefined,
  declaredTargets: readonly ExecutionTarget[],
): boolean {
  if (unavailable.has(adapterKey(selection.adapter))) return true;
  const authKey = target !== undefined
    ? adapterProviderKey(target.adapter, target.provider)
    : selection.provider !== null
      ? adapterProviderKey(selection.adapter, selection.provider)
      : hasAdapterProviderKey(unavailable, selection.adapter)
        ? resolveAdapterProvider(selection, declaredTargets)
        : null;
  if (authKey !== null && unavailable.has(authKey)) return true;
  if (![...unavailable].some((key) => key.startsWith('provider-model:'))) return false;
  const key = target === undefined
    ? resolveProviderModel(selection, declaredTargets)
    : providerModelKey(target.provider, target.model);
  return unavailable.has(key);
}
