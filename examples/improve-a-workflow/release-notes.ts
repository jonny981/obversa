/**
 * Release notes for a version. A writer drafts them from its brief, and a
 * check sends a draft back when it has no upgrade steps. The writer here is a
 * function that follows its brief to the letter: it writes upgrade steps only
 * when the brief or a finding asks for them.
 */
import { fnJob, kickback, pipeline, type Job } from '@obversa/runtime';

const brief = 'Write the release notes for version 2.0, one line per change.';

export function releaseNotes(): Job {
  let notes = '';
  const write = fnJob('write', (ctx) => {
    const askedForSteps = /upgrade steps/i.test(brief) || ctx.lastReview !== undefined;
    notes = askedForSteps
      ? '- Exports keep their header row.\n\nUpgrade steps: none.'
      : '- Exports keep their header row.';
    return notes;
  });
  const check = fnJob('check', () => (notes.includes('Upgrade steps')
    ? 'the notes have upgrade steps'
    : kickback('write', 'the notes have no upgrade steps')));
  return pipeline('release-notes', [
    { name: 'write', job: write },
    { name: 'check', job: check, acceptsKickbackTo: ['write'] },
  ], { maxKickbacks: 2 });
}
