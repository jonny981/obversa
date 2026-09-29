import { createSurfaceClient } from './client.js';

const el = (id) => document.getElementById(id);
let client;
let proposal;
let reviewed;
let sending = false;

function error(message) {
  el('error').textContent = message;
  el('error').hidden = false;
}

function answer() {
  return {
    audience: new FormData(el('review')).get('audience'),
    title: el('title').value,
    annotations: [...document.querySelectorAll('[data-section]')]
      .filter((field) => field.value.trim())
      .map((field) => ({ sectionId: field.dataset.section, note: field.value })),
  };
}

function changed() {
  reviewed = undefined;
  el('preview-panel').hidden = true;
  const value = answer();
  const edited = value.audience !== null || value.title !== proposal.title || value.annotations.length > 0;
  el('approve').disabled = edited;
  el('approval-hint').textContent = edited
    ? 'Send your feedback first. You can approve the revised version when it returns.'
    : 'Happy with this version? Approve it to continue the workflow.';
}

function finish(title, detail) {
  el('review').hidden = true;
  el('error').hidden = true;
  el('done-title').textContent = title;
  el('done-detail').textContent = detail;
  el('done').hidden = false;
  el('done').focus();
}

async function send(action) {
  if (sending) return;
  sending = true;
  const buttons = [...document.querySelectorAll('button')];
  buttons.forEach((button) => { button.disabled = true; });
  try {
    if (action === 'cancel') {
      await client.cancel();
      finish('Review closed', 'The work has not been approved.');
    } else {
      if (action === 'feedback' && (!reviewed || JSON.stringify(answer()) !== JSON.stringify(reviewed))) {
        throw new Error('Review your feedback before sending it.');
      }
      await client.submit(`/api/${action}`, action === 'feedback' ? reviewed : {});
      finish(action === 'approve' ? 'Version approved' : 'Feedback sent', action === 'approve'
        ? 'The workflow can continue.'
        : 'The agent will revise the proposal. The next review will open when it is ready.');
    }
  } catch (cause) {
    error(cause.message);
    buttons.forEach((button) => { button.disabled = false; });
    const value = answer();
    el('approve').disabled = value.audience !== null || value.title !== proposal.title || value.annotations.length > 0;
  } finally { sending = false; }
}

try {
  client = createSurfaceClient();
  const model = await client.api('/api/proposal');
  proposal = model.proposal;
  el('question').textContent = model.question;
  el('title').value = proposal.title;
  for (const [index, section] of proposal.sections.entries()) {
    const box = document.createElement('div');
    box.className = 'passage';
    const quote = document.createElement('blockquote');
    quote.textContent = section.text;
    const label = document.createElement('label');
    label.htmlFor = `note-${index}`;
    label.textContent = `Your note on passage ${index + 1}`;
    const note = document.createElement('textarea');
    note.id = label.htmlFor;
    note.dataset.section = section.id;
    box.append(quote, label, note);
    el('sections').append(box);
  }
  el('review').hidden = false;
  el('review').addEventListener('input', changed);
  el('review').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const submitted = answer();
      const result = await client.api('/api/preview', submitted);
      if (JSON.stringify(answer()) !== JSON.stringify(submitted)) return;
      reviewed = submitted;
      el('prompt').textContent = result.prompt;
      el('preview-panel').hidden = false;
      el('error').hidden = true;
      el('prompt').focus();
    } catch (cause) { error(cause.message); }
  });
  el('send').addEventListener('click', () => send('feedback'));
  el('clear').addEventListener('click', () => {
    el('title').value = proposal.title;
    document.querySelectorAll('[name=audience]').forEach((field) => { field.checked = false; });
    document.querySelectorAll('[data-section]').forEach((field) => { field.value = ''; });
    el('error').hidden = true;
    changed();
    el('title').focus();
  });
  el('approve').addEventListener('click', () => send('approve'));
  el('cancel').addEventListener('click', () => send('cancel'));
} catch (cause) { error(cause.message); client?.dispose(); }
