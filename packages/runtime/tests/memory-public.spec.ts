import { describe, expect, it } from 'vitest';

import { curate } from '../src/memory.js';

describe('runtime memory helpers', () => {
  it('keeps a grounded prompt when the curator rejects it', async () => {
    const result = await curate({
      documents: [],
      missing: [],
      prompt: 'reference',
    }, {
      intent: 'summarize',
      decide: () => {
        throw new Error('unavailable');
      },
    });

    expect(result.mode).toBe('grounded');
    if (result.mode === 'grounded') {
      expect(result.reason).toBe('callback_failed');
      expect(result.prompt).toContain('untrusted data');
    }
  });
});
