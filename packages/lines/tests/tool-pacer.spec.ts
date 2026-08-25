import { describe, it, expect } from 'vitest';

import { toolPacer } from '../src/engines/engine.ts';

// toolPacer backs EngineOptions.minToolIntervalMs: the agent-sdk engine awaits
// it in a PreToolUse hook, so consecutive tool executions are at least the
// interval apart. Real (small) timers; only >= bounds are asserted (loosened
// to absorb timer jitter) — an upper bound on elapsed wall time would flake
// on a loaded CI runner.

describe('toolPacer', () => {
  it('the second call waits out the interval', async () => {
    const pace = toolPacer(50);
    await pace();
    const t1 = Date.now();
    await pace();
    expect(Date.now() - t1).toBeGreaterThanOrEqual(45);
  });

  it('spaces every consecutive pair, not just the first', async () => {
    const pace = toolPacer(50);
    await pace();
    await pace();
    const t = Date.now();
    await pace();
    expect(Date.now() - t).toBeGreaterThanOrEqual(45);
  });

  it('serializes concurrent callers into strictly spaced slots', async () => {
    // The SDK awaits parallel-safe tools' PreToolUse hooks concurrently, so a
    // burst of tool calls means concurrent pace() calls: each must claim its
    // own slot rather than all reading the same one and firing together.
    const pace = toolPacer(50);
    const t0 = Date.now();
    const elapsed = await Promise.all(
      [0, 1, 2].map(() => pace().then(() => Date.now() - t0)),
    );
    elapsed.sort((a, b) => a - b);
    expect(elapsed[1]!).toBeGreaterThanOrEqual(45);
    expect(elapsed[2]!).toBeGreaterThanOrEqual(90);
  });
});
