import { describe, expect, it, vi } from 'vitest';

import { exactPid, isProcessAlive } from './process-fixture.ts';

describe('a test signal without a process id', () => {
  it('fails before it sends any signal', () => {
    // Zero or a negative number would signal a whole process group.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      for (const pid of [0, -1, Number.NaN, undefined]) {
        expect(() => process.kill(exactPid(pid), 'SIGKILL')).toThrow(TypeError);
        expect(() => isProcessAlive(pid as number)).toThrow(TypeError);
      }
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });
});
