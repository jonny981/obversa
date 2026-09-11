#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';

// Bound the fixture even if its host cannot finish adapter cleanup.
const deadline = setTimeout(() => process.exit(124), 10_000);
try {
  const args = process.argv.slice(2);
  const grok = args.includes('--prompt-file');
  let prompt;
  if (grok) {
    assert.equal(args[args.indexOf('--output-format') + 1], 'json');
    prompt = await readFile(args[args.indexOf('--prompt-file') + 1], 'utf8');
  } else {
    assert.equal(args[0], 'run');
    assert.equal(args[args.indexOf('--format') + 1], 'json');
    assert.ok(args.includes('--pure'));
    prompt = '';
    for await (const chunk of process.stdin) prompt += chunk;
  }
  const { member, input } = JSON.parse(prompt);
  assert.equal(typeof input.task, 'string');
  assert.ok(Array.isArray(input.messages));
  assert.ok(['writer', 'reviewer'].includes(member));
  await appendFile(process.env.OBVERSA_TEAM_CAPTURE, `${JSON.stringify({
    adapter: grok ? 'grok-cli' : 'opencode-cli', pid: process.pid, member, input,
  })}\n`);
  let result;
  if (member === 'reviewer') {
    const question = input.messages.find((message) => message.sender === 'writer'
      && message.mentions.includes(member));
    assert.ok(question, 'The reviewer requires the saved writer question.');
    result = {
      summary: 'Draft checked.',
      posts: [{ roomId: question.roomId, text: `Reviewed ${question.id}: ${question.text}`, mentions: ['writer'] }],
    };
  } else if (input.result === null) {
    assert.deepEqual(input.messages, []);
    result = {
      summary: 'Review requested.',
      posts: [{ roomId: 'review', text: `Please review: ${input.task}`, mentions: ['reviewer'] }],
    };
  } else {
    const reply = input.messages.find((message) => message.sender === 'reviewer'
      && message.mentions.includes(member));
    assert.ok(reply, 'The writer requires the saved reviewer reply.');
    result = {
      summary: `Finished ${input.task}: ${reply.text}`,
      data: { replyId: reply.id, reply: reply.text },
    };
  }
  if (grok) {
    const model = args[args.indexOf('--model') + 1];
    console.log(JSON.stringify({ stopReason: 'end_turn', modelUsage: { [model]: { modelCalls: 1 } }, structuredOutput: result }));
  } else {
    console.log(JSON.stringify({
      type: 'text', timestamp: 1, sessionID: 'team-fixture',
      part: {
        id: 'result', sessionID: 'team-fixture', messageID: 'turn', type: 'text',
        text: `OBVERSA_STRUCTURED_RESULT_V1\n${JSON.stringify(result)}`, time: { start: 1, end: 2 },
      },
    }));
    console.log(JSON.stringify({
      type: 'step_finish', timestamp: 2, sessionID: 'team-fixture',
      part: { id: 'finish', sessionID: 'team-fixture', messageID: 'turn', type: 'step-finish', reason: 'stop', cost: 0, tokens: {} },
    }));
  }
} finally {
  clearTimeout(deadline);
}
