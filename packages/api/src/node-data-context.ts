import type { Memory } from './memory-types.js';
import type { JsonObject, JsonValue } from './json.js';

export interface NodeDataContext {
  readonly input: JsonValue;
  readonly memory: Memory | null;
  readonly scratchDirectory: string;
  readonly workspaceDirectory: string | null;
  readonly trustedCaller: JsonObject;
  readonly permissions: readonly string[];
  readonly signal: AbortSignal;
}
