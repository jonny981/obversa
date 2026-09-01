/**
 * A scripted, offline environment, mirroring `MockEngine`. It simulates a deploy
 * (hands back a URL + env vars, counts up/down) with no network, so the
 * lifecycle binding and gate integration run the same code paths in tests as a
 * real sst/Vercel adapter would.
 */

import type { Workspace } from '../core/types.js';
import type { Environment, EnvHandle } from './environment.js';

export interface MockEnvOptions {
  /** The URL to hand back. A function derives it from the workspace (branch). */
  url?: string | ((ws: Workspace) => string);
  /** Extra env vars to inject alongside `BASE_URL`. */
  env?: Record<string, string>;
  onUp?: (ws: Workspace) => void;
  onDown?: () => void;
}

export class MockEnvironment implements Environment {
  readonly name = 'mock-env';
  upCount = 0;
  downCount = 0;

  constructor(private readonly opts: MockEnvOptions = {}) {}

  async up(workspace: Workspace): Promise<EnvHandle> {
    this.upCount += 1;
    const url =
      typeof this.opts.url === 'function'
        ? this.opts.url(workspace)
        : (this.opts.url ?? `http://localhost/${workspace.branch ?? 'main'}`);
    this.opts.onUp?.(workspace);
    const onDown = this.opts.onDown;
    return {
      url,
      env: { BASE_URL: url, ...this.opts.env },
      down: async () => {
        this.downCount += 1;
        onDown?.();
      },
    };
  }
}
