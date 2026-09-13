import { describe, expect, it } from 'vitest';
import { outcomeFromAgentText } from '../src/index.js';

import { INVALID_TEAM_DECISION } from '../src/agent-response.js';

describe('outcomeFromAgentText', () => {
  it.each([
    ['Here is my review: {"status":"pass","summary":"looks good"}', 'looks good'],
    ['```json\n{"status":"pass","summary":"looks good"}\n```', 'looks good'],
  ])('accepts a decision object in %s', (text, summary) => {
    expect(outcomeFromAgentText(text)).toEqual({ status: 'pass', summary });
  });

  it('turns a revise decision into a targeted failing outcome', () => {
    expect(outcomeFromAgentText(
      '{"status":"revise","summary":"needs another pass","findings":[{"evidence":"missing check"}]}',
      'implementation',
    )).toMatchObject({
      status: 'fail',
      revision: { target: 'implementation', reason: 'needs another pass' },
    });
  });

  it('keeps malformed replies as a named failure', () => {
    expect(outcomeFromAgentText('Here is my review: {not valid JSON}')).toMatchObject({
      status: 'fail',
      summary: INVALID_TEAM_DECISION,
    });
  });
});
