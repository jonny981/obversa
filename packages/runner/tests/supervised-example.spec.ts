import { readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { WorkspaceProvider } from '@obversa/runtime';

// Real work: these tests run the real supervised example, which creates a
// Git repository and writes files to disk, so this file declares its own
// time limit; the suite default is a hang guard, not a speed bar.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const fault = vi.hoisted(() => ({
  root: '',
  token: '',
  provider: undefined as WorkspaceProvider | undefined,
  startupFailure: new Error('Injected startup verification failure'),
}));

vi.mock('@obversa/runtime', async (importOriginal) => {
  const runtime = await importOriginal<typeof import('@obversa/runtime')>();
  return {
    ...runtime,
    createGitWorktreeProvider: (...args: Parameters<typeof runtime.createGitWorktreeProvider>) => {
      const provider = runtime.createGitWorktreeProvider(...args);
      fault.root = args[0].repositoryPath;
      fault.provider = provider;
      return {
        ...provider,
        acquireLease: async (...leaseArgs: Parameters<WorkspaceProvider['acquireLease']>) => {
          const result = await provider.acquireLease(...leaseArgs);
          if (result.ok) fault.token = result.token;
          return result;
        },
        verify: async (...verifyArgs: Parameters<WorkspaceProvider['verify']>) => {
          const result = await provider.verify(...verifyArgs);
          if (!result.ok) throw new Error('The real example workspace unexpectedly drifted');
          throw fault.startupFailure;
        },
        releaseLease: async () => ({ ok: false as const, kind: 'not-owner' as const }),
      };
    },
  };
});

it('the real example preserves files and the original failure when startup cannot release its lease', async () => {
  try {
    let failure: unknown;
    try {
      await import('../../../examples/packages/supervised-run.ts');
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'WORKSPACE_RELEASE' });
    expect((failure as Error).cause).toBeInstanceOf(AggregateError);
    expect(((failure as Error).cause as AggregateError).errors[0]).toBe(fault.startupFailure);

    expect(fault.root).not.toBe('');
    expect(fault.token).not.toBe('');
    const temporary = dirname(fault.root);
    expect((await stat(temporary)).isDirectory()).toBe(true);
    expect((await readFile(join(fault.root, 'host.mjs'), 'utf8')).length).toBeGreaterThan(0);
    expect((await stat(join(temporary, 'storage/runner-locks/offline-example/example'))).isDirectory()).toBe(true);

    const runtime = await vi.importActual<typeof import('@obversa/runtime')>('@obversa/runtime');
    const contender = runtime.createGitWorktreeProvider({ repositoryPath: fault.root });
    const anchor = await contender.capture();
    expect(await contender.acquireLease('other-watchdog', 'example', anchor)).toEqual({
      ok: false, kind: 'held', owner: 'runner:example',
    });
  } finally {
    // Release through the real provider, not the injected refusal.
    if (fault.provider !== undefined && fault.token !== '') {
      await fault.provider.releaseLease(fault.token).catch(() => {});
    }
    if (fault.root !== '') await rm(dirname(fault.root), { recursive: true, force: true });
  }
}, 30_000);
