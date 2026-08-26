import { describe, expect, it } from 'vitest';

import type { Memory } from '@obversa/memory';
import type { GraphRequirements } from '../src/graph/plan.ts';
import type { GraphBindings } from '../src/graph/type.ts';

const memory = {} as Memory;

const required = { memory } satisfies GraphBindings<{ memory: 'required' }>;
const unused = {} satisfies GraphBindings<{ memory: 'unused' }>;
const widened = { memory } satisfies GraphBindings<GraphRequirements>;

// @ts-expect-error A graph that declares memory must receive the port.
const missing: GraphBindings<{ memory: 'required' }> = {};
// @ts-expect-error A memory-free graph must not receive an unused binding.
const extra: GraphBindings<{ memory: 'unused' }> = { memory };
// @ts-expect-error A widened requirement can require memory at runtime.
const widenedMissing: GraphBindings<GraphRequirements> = {};

describe('GraphBindings', () => {
  it('keeps memory requirements visible to both supported compilers', () => {
    expect(required.memory).toBe(memory);
    expect(unused).toEqual({});
    expect(widened.memory).toBe(memory);
    expect(missing).toEqual({});
    expect(extra).toEqual({ memory });
    expect(widenedMissing).toEqual({});
  });
});
