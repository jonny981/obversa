import { describe, expect, it } from 'vitest';

import { INVALID_TEAM_DECISION, outcomeFromAgentText } from '../src/agent-response.js';

describe('outcomeFromAgentText', () => {
  it.each([
    ['Here is my review: {"status":"pass","summary":"looks good"}', 'looks good'],
    ['```json\n{"status":"pass","summary":"looks good"}\n```', 'looks good'],
  ])('accepts a decision object in %s', (text, summary) => {
    expect(outcomeFromAgentText(text)).toEqual({ status: 'pass', summary });
  });

  it('keeps malformed replies as a named failure', () => {
    expect(outcomeFromAgentText('Here is my review: {not valid JSON}')).toMatchObject({
      status: 'fail',
      summary: INVALID_TEAM_DECISION,
    });
  });
});
