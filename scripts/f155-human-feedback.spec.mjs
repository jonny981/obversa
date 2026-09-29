import assert from 'node:assert/strict';
import test from 'node:test';

import { composeFeedback } from '../examples/human-feedback/feedback.ts';

const proposal = {
  title: 'Welcome to the project',
  sections: [
    { id: 'intro', text: 'Create an account before you can try the editor.' },
    { id: 'sharing', text: 'Invite your team to continue.' },
  ],
};

test('selections, edits and anchored notes reach the composed feedback together', () => {
  const result = composeFeedback(proposal, {
    audience: 'first-time visitors',
    title: 'Try the editor',
    annotations: [
      { sectionId: 'intro', note: 'Let me try it before signing up.' },
      { sectionId: 'sharing', note: 'Make this optional.' },
    ],
  });
  assert.deepEqual(result.feedback, {
    audience: 'first-time visitors',
    title: { before: 'Welcome to the project', after: 'Try the editor' },
    annotations: [
      { sectionId: 'intro', quote: 'Create an account before you can try the editor.', note: 'Let me try it before signing up.' },
      { sectionId: 'sharing', quote: 'Invite your team to continue.', note: 'Make this optional.' },
    ],
  });
  assert.equal(result.prompt, [
    'Revise the proposal using my decisions below. Keep parts I did not comment on.',
    'Audience: first-time visitors.',
    'Replace the title "Welcome to the project" with "Try the editor".',
    'On "Create an account before you can try the editor.": Let me try it before signing up.',
    'On "Invite your team to continue.": Make this optional.',
  ].join('\n\n'));
});

test('a note cannot quote a section the person was not shown', () => {
  assert.throws(() => composeFeedback(proposal, {
    audience: 'first-time visitors', title: proposal.title,
    annotations: [{ sectionId: 'absent', note: 'Replace everything.' }],
  }), /section/);
});

test('a malformed selection is refused instead of becoming a prompt', () => {
  assert.throws(() => composeFeedback(proposal, {
    audience: 'arbitrary input', title: proposal.title, annotations: [],
  }), /audience/);
});
