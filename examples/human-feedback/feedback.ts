import type { JsonObject } from '@obversa/runtime';

export interface Proposal {
  readonly title: string;
  readonly sections: readonly { readonly id: string; readonly text: string }[];
}

export function composeFeedback(proposal: Proposal, answer: unknown): { feedback: JsonObject; prompt: string } {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) {
    throw new TypeError('Choose an audience and add your feedback.');
  }
  const value = answer as Record<string, unknown>;
  if (value.audience !== 'first-time visitors' && value.audience !== 'returning users') {
    throw new TypeError('Choose an audience.');
  }
  if (typeof value.title !== 'string' || !value.title.trim()) {
    throw new TypeError('Enter a title.');
  }
  if (!Array.isArray(value.annotations)) throw new TypeError('The section notes must be a list.');
  const seen = new Set<string>();
  const annotations = value.annotations.map((item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('A section note is invalid.');
    const annotation = item as Record<string, unknown>;
    const section = proposal.sections.find((candidate) => candidate.id === annotation.sectionId);
    if (!section || seen.has(section.id)) throw new TypeError('Choose a section from this proposal once.');
    if (typeof annotation.note !== 'string' || !annotation.note.trim()) throw new TypeError('Enter your note for the section.');
    seen.add(section.id);
    return { sectionId: section.id, quote: section.text, note: annotation.note.trim() };
  });
  const title = value.title.trim();
  return {
    feedback: {
      audience: value.audience,
      title: { before: proposal.title, after: title },
      annotations,
    },
    prompt: [
      'Revise the proposal using my decisions below. Keep parts I did not comment on.',
      `Audience: ${value.audience}.`,
      ...(title === proposal.title ? [] : [`Replace the title ${JSON.stringify(proposal.title)} with ${JSON.stringify(title)}.`]),
      ...annotations.map(({ quote, note }) => `On ${JSON.stringify(quote)}: ${note}`),
    ].join('\n\n'),
  };
}
