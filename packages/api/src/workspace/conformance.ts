/**
 * The workspace provider conformance kit (roadmap D12): the behavioral
 * checks every provider must pass — capture and verify naming drift, the
 * lease lifecycle with typed second claims, fork requiring a held lease
 * and starting at the anchored revision, and recovery never stealing a
 * live lease. Framework-free, like the graph kit.
 */

import { isDeepStrictEqual } from 'node:util';

import type { WorkspaceAnchor, WorkspaceProvider } from './provider.js';

export interface WorkspaceProviderConformanceFixture {
  readonly provider: WorkspaceProvider;
  /** An anchor captured from the prepared workspace. */
  readonly anchor: WorkspaceAnchor;
  /** A unique child identity for the fork cases. */
  readonly childId: string;
  /** Mutates the workspace after the fork cases, so drift is observable. */
  readonly driftWorkspace: () => Promise<void>;
}

export interface WorkspaceProviderConformanceFailure {
  readonly case: string;
  readonly message: string;
}

export interface WorkspaceProviderConformanceReport {
  readonly ok: boolean;
  readonly cases: number;
  readonly failures: readonly WorkspaceProviderConformanceFailure[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run the behavioral checks for any workspace provider. */
export function runWorkspaceProviderConformance(
  fixture: WorkspaceProviderConformanceFixture,
): Promise<WorkspaceProviderConformanceReport> {
  const { provider, anchor, childId, driftWorkspace } = fixture;
  const cases: { name: string; run: () => Promise<void> }[] = [
    {
      name: 'verify ok on the captured anchor',
      run: async () => {
        const result = await provider.verify(anchor);
        if (!isDeepStrictEqual(result, { ok: true })) {
          throw new Error(`expected ok, received ${JSON.stringify(result)}`);
        }
      },
    },
    {
      name: 'fork requires a lease held for the anchor',
      run: async () => {
        const result = await provider.fork(anchor, childId, 'not-a-token');
        if (!(result.ok === false && result.kind === 'unleased')) {
          throw new Error(`expected an unleased refusal, received ${JSON.stringify(result)}`);
        }
      },
    },
    {
      name: 'lease lifecycle: acquire, second claim held, release, reacquire',
      run: async () => {
        const first = await provider.acquireLease('kit-owner', 'kit-scope', anchor);
        if (first.ok !== true) {
          throw new Error(`acquire failed: ${JSON.stringify(first)}`);
        }
        const second = await provider.acquireLease('kit-other', 'kit-scope', anchor);
        if (!(second.ok === false && second.kind === 'held' && second.owner === 'kit-owner')) {
          throw new Error(`second claim not typed as held: ${JSON.stringify(second)}`);
        }
        const wrongRelease = await provider.releaseLease('not-the-token');
        if (!(wrongRelease.ok === false && wrongRelease.kind === 'not-owner')) {
          throw new Error(`wrong token release not refused: ${JSON.stringify(wrongRelease)}`);
        }
        const released = await provider.releaseLease(first.token);
        if (released.ok !== true) {
          throw new Error(`release failed: ${JSON.stringify(released)}`);
        }
        const reacquired = await provider.acquireLease('kit-owner', 'kit-scope', anchor);
        if (reacquired.ok !== true) {
          throw new Error(`reacquire failed: ${JSON.stringify(reacquired)}`);
        }
        const reRelease = await provider.releaseLease(
          reacquired.ok === true ? reacquired.token : '',
        );
        if (reRelease.ok !== true) {
          throw new Error(`reacquired release failed: ${JSON.stringify(reRelease)}`);
        }
      },
    },
    {
      name: 'fork starts at the anchored revision under its lease',
      run: async () => {
        const lease = await provider.acquireLease('kit-owner', 'kit-scope', anchor);
        if (lease.ok !== true) {
          throw new Error(`acquire failed: ${JSON.stringify(lease)}`);
        }
        const forked = await provider.fork(anchor, childId, lease.token);
        if (forked.ok !== true) {
          throw new Error(`fork failed: ${JSON.stringify(forked)}`);
        }
        if (forked.anchor.head !== anchor.head) {
          throw new Error('the forked worktree does not start at the anchored revision');
        }
        const released = await provider.releaseLease(lease.token);
        if (released.ok !== true) {
          throw new Error(`release failed: ${JSON.stringify(released)}`);
        }
      },
    },
    {
      name: 'recovery on no lease is typed, not a steal',
      run: async () => {
        const result = await provider.recoverIncompleteLease();
        if (!(result.ok === false && result.kind === 'none')) {
          throw new Error(`expected a typed none, received ${JSON.stringify(result)}`);
        }
      },
    },
    {
      name: 'drift is named and a changed anchor refuses fork',
      run: async () => {
        await driftWorkspace();
        const drifted = await provider.verify(anchor);
        if (drifted.ok !== false || drifted.drift.length === 0) {
          throw new Error(`expected named drift, received ${JSON.stringify(drifted)}`);
        }
        const lease = await provider.acquireLease('kit-owner', 'kit-scope', anchor);
        if (lease.ok !== true) {
          throw new Error(`acquire failed: ${JSON.stringify(lease)}`);
        }
        const forked = await provider.fork(anchor, `${childId}-drift`, lease.token);
        if (!(forked.ok === false && forked.kind === 'anchor-changed')) {
          throw new Error(`expected an anchor-changed refusal, received ${JSON.stringify(forked)}`);
        }
        await provider.releaseLease(lease.token);
      },
    },
  ];

  return (async () => {
    const failures: WorkspaceProviderConformanceFailure[] = [];
    for (const item of cases) {
      try {
        await item.run();
      } catch (error) {
        failures.push({ case: item.name, message: message(error) });
      }
    }
    return Object.freeze({
      ok: failures.length === 0,
      cases: cases.length,
      failures: Object.freeze(failures),
    });
  })();
}

/** Throw one readable error when a provider breaks the contract. */
export async function assertWorkspaceProviderConformance(
  fixture: WorkspaceProviderConformanceFixture,
): Promise<void> {
  const report = await runWorkspaceProviderConformance(fixture);
  if (report.ok) return;
  const detail = report.failures
    .map((failure) => `${failure.case}: ${failure.message}`)
    .join('; ');
  throw new Error(`Workspace provider conformance failed: ${detail}`);
}
