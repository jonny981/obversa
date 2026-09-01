import { describe, it, expect, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { run, fnJob } from '../src/api.ts';
import type { RunOptions, Workspace } from '../src/api.ts';
import { MockEngine } from '../src/testing.ts';
import { commandEnvironment } from '../src/env/command.ts';
import { tmpRepo, cleanupRepos } from './git-helpers.ts';

afterAll(cleanupRepos);

const base: RunOptions = {
  engine: 'mock',
  engines: { mock: new MockEngine(() => '') },
};
const node = (script: string) => ({ cmd: 'node', args: ['-e', script] });

describe('commandEnvironment (the generic CLI adapter)', () => {
  it('deploys, reads JSON outputs, injects env, tears down', async () => {
    const repo = await tmpRepo();
    const envir = commandEnvironment({
      name: 'fake',
      stage: () => 'preview-x',
      deploy: () => node(`require('fs').writeFileSync('deployed','1')`),
      outputs: () => node(`console.log(JSON.stringify({API_URL:'http://preview.test'}))`),
      destroy: () => node(`require('fs').writeFileSync('destroyed','1')`),
      map: (o) => ({ url: String(o.API_URL), env: { BASE_URL: String(o.API_URL) } }),
    });

    let seenUrl: string | undefined;
    let seenBase: string | undefined;
    const job = fnJob('inspect', async (ctx) => {
      seenUrl = ctx.environment?.url;
      seenBase = ctx.environment?.env.BASE_URL;
      return { status: 'pass' };
    });

    const { outcome } = await run(job, { ...base, cwd: repo, environment: envir });
    expect(outcome.status).toBe('pass');
    expect(seenUrl).toBe('http://preview.test');
    expect(seenBase).toBe('http://preview.test');
    expect(existsSync(join(repo, 'deployed'))).toBe(true);
    expect(existsSync(join(repo, 'destroyed'))).toBe(true); // torn down after
  });

  it('handles non-JSON outputs via the raw stdout (the docker port case)', async () => {
    const repo = await tmpRepo();
    const envir = commandEnvironment({
      name: 'fake-docker',
      deploy: () => node(`0`),
      outputs: () => node(`console.log('0.0.0.0:49153')`),
      destroy: () => node(`0`),
      map: (_o, _s, raw) => {
        const hp = raw.trim().replace(/^0\.0\.0\.0:/, 'localhost:');
        return { url: `http://${hp}`, env: { BASE_URL: `http://${hp}` } };
      },
    });
    const ws: Workspace = { dir: repo, branch: 'feat/x' };
    const handle = await envir.up(ws, new AbortController().signal);
    expect(handle.url).toBe('http://localhost:49153');
    await handle.down(new AbortController().signal);
  });

  it('throws when the deploy command fails (a clean run failure upstream)', async () => {
    const repo = await tmpRepo();
    const envir = commandEnvironment({
      name: 'fake',
      deploy: () => node(`process.exit(1)`),
      destroy: () => node(`0`),
    });
    await expect(
      envir.up({ dir: repo }, new AbortController().signal),
    ).rejects.toThrow(/deploy failed/);
  });

  it('is optional — a research pipeline with no environment just runs', async () => {
    const repo = await tmpRepo();
    let hadEnv = true;
    const job = fnJob('research', async (ctx) => {
      hadEnv = ctx.environment !== undefined;
      return { status: 'pass' };
    });
    const { outcome } = await run(job, { ...base, cwd: repo });
    expect(outcome.status).toBe('pass');
    expect(hadEnv).toBe(false);
  });
});
