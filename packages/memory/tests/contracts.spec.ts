import { describe, expect, it } from 'vitest';

import {
  MEMORY_ROOT,
  type Memory,
  type MemoryResult,
} from '../src/index.js';
import {
  type MemoryConformanceFactory,
  runMemoryConformance,
} from '../src/testing.js';

describe('@obversa/memory', () => {
  it('publishes the fixed memory root', () => {
    expect(MEMORY_ROOT).toBe('/memories');
  });

  it('reports conformance failures without depending on a test framework', async () => {
    const factory = ({ scope }: { scope: string }): Memory => ({
      scope,
      async execute(command): Promise<MemoryResult> {
        return {
          ok: false,
          command: command.command,
          error: {
            code: 'STORAGE_ERROR',
            message: 'Deliberately broken adapter.',
          },
        };
      },
    });

    const report = await runMemoryConformance(factory);

    expect(report.ok).toBe(false);
    expect(report.cases).toBeGreaterThan(0);
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures[0]).toEqual(
      expect.objectContaining({
        case: expect.any(String),
        message: expect.any(String),
      }),
    );
  });

  it('runs adapters that open asynchronously', async () => {
    let executeCalls = 0;
    const factory: MemoryConformanceFactory = async ({ scope }) => ({
      scope,
      async execute(command): Promise<MemoryResult> {
        executeCalls += 1;
        return {
          ok: false,
          command: command.command,
          error: {
            code: 'STORAGE_ERROR',
            message: 'Deliberately broken adapter.',
          },
        };
      },
    });

    const report = await runMemoryConformance(factory);

    expect(executeCalls).toBeGreaterThan(0);
    expect(report.failures[0]?.message).toContain('STORAGE_ERROR');
  });

  it('compares conformance results without depending on object key order', async () => {
    const report = await runMemoryConformance(({ scope }) => ({
      scope,
      async execute(): Promise<MemoryResult> {
        return {
          value: { entries: [], path: '/memories', kind: 'directory' },
          command: 'view',
          ok: true,
        };
      },
    }));

    expect(report.ok).toBe(false);
    expect(report.failures.find((failure) => failure.case === 'empty root view')).toBeUndefined();
  });
});
