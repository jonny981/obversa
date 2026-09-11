import { describe, expect, it } from 'vitest';

import { outcomeFromAgentText } from '../src/agent-response.js';

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
      summary: 'The engine response was not a valid team decision JSON object.',
    });
  });
});
