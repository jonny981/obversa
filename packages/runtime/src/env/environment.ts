/**
 * The Environment provider — the third axis, after Engine (where the agent
 * thinks) and Workspace (where the code lives). Environment is where the code
 * runs: local services, or a per-branch cloud preview. It lets the gate test the
 * running thing, so "done" can mean "the e2e suite passes against the running
 * preview", not just "unit tests pass against static files on disk".
 *
 * Like `Engine`, this is only an interface. The runtime owns the interface and the
 * lifecycle binding; the actual adapter (sst, Vercel, Docker, …) is
 * provider-specific and lives in the consumer's loop definition, next to the
 * deploy config it wraps. The runtime never takes a dependency on a deploy tool.
 * Implement `up`, return a handle:
 *
 *   const sstEnv: Environment = {
 *     name: 'sst',
 *     async up(ws) {
 *       const stage = slug(ws.branch);           // per-branch stage
 *       const out = await sh('sst', ['deploy', '--stage', stage], ws.dir);
 *       return {
 *         url: out.url,
 *         env: { BASE_URL: out.url },
 *         down: () => sh('sst', ['remove', '--stage', stage], ws.dir),
 *       };
 *     },
 *   };
 */

export interface EnvironmentWorkspace {
  readonly dir: string;
  readonly branch?: string;
}

/** A running environment for one workspace. Returned by `Environment.up`. */
export interface EnvHandle {
  /** Addressable base URL (a preview deployment, or a local server), if any. */
  readonly url?: string;
  /**
   * Variables injected into gate commands, judge calls, and agent turns, e.g.
   * `BASE_URL`, `DATABASE_URL`. This is how `commandSucceeds('playwright', …)`
   * reaches the running preview.
   */
  readonly env: Record<string, string>;
  /**
   * Redeploy when the branch advances (a cloud preview that tracks commits).
   * Optional: a local-services env has nothing to sync.
   */
  sync?(commit: string, signal: AbortSignal): Promise<void>;
  /** Tear the environment down. */
  down(signal: AbortSignal): Promise<void>;
}

/** Brings a workspace's code up so the gate can test the running thing. */
export interface Environment {
  readonly name: string;
  up(workspace: EnvironmentWorkspace, signal: AbortSignal): Promise<EnvHandle>;
}

/** Duck-type guard: a ready-made `Environment` rather than something else. */
export function isEnvironment(value: unknown): value is Environment {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Environment).name === 'string' &&
    typeof (value as Environment).up === 'function'
  );
}
