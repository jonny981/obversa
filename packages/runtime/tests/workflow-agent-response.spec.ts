import { describe, expect, it } from 'vitest';

import { INVALID_TEAM_DECISION, outcomeFromAgentText } from '../src/workflow-agent-response.ts';

describe('reading a reviewer or writer decision from its reply', () => {
  it('reads the final answer when a JSON example comes before it', () => {
    const reply = [
      'The config the brief asks for looks like this:',
      '',
      '```json',
      '{ "name": "build", "retries": 2 }',
      '```',
      '',
      'It is in place and the tests pass.',
      '',
      '{"status":"revise","summary":"Add a test for zero retries.","findings":[{"message":"no test for retries: 0"}]}',
    ].join('\n');

    const outcome = outcomeFromAgentText(reply, 'build');

    expect(outcome.revision?.reason).toBe('Add a test for zero retries.');
    expect(outcome.revision?.target).toBe('build');
  });

  it('reads the final answer when an example decision comes before it', () => {
    const reply = [
      'The answer has the shape {"status":"pass","summary":"..."}, and mine is:',
      '{"status":"revise","summary":"The page still names the old option."}',
    ].join('\n');

    const outcome = outcomeFromAgentText(reply);

    expect(outcome.revision?.reason).toBe('The page still names the old option.');
  });

  it('reads the final answer after code with braces in it', () => {
    const reply = [
      'I checked this function:',
      'function total(items) { return items.reduce((sum, item) => sum + item.cost, 0); }',
      '{"status":"pass","summary":"The totals are right."}',
    ].join('\n');

    expect(outcomeFromAgentText(reply)).toEqual({ status: 'pass', summary: 'The totals are right.' });
  });

  it('reads a decision in a fenced json block', () => {
    const reply = 'Done.\n\n```json\n{"status":"pass","summary":"Looks good."}\n```\n';

    expect(outcomeFromAgentText(reply)).toEqual({ status: 'pass', summary: 'Looks good.' });
  });

  it('is no decision when no object has a status and a summary', () => {
    const outcome = outcomeFromAgentText('Here is an example: {"name":"build"}. {"status":"pass","summary":""}');

    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toBe(INVALID_TEAM_DECISION);
  });
});
