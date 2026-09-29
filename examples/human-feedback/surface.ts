import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CallbackRequest, InteractionResponse, JsonObject } from '@obversa/runtime';
import { runSurface } from '@obversa/surface';

import { composeFeedback, type Proposal } from './feedback.js';

export const responseSchema: JsonObject = {
  type: 'object',
  required: ['decision', 'feedback', 'prompt'],
  properties: {
    decision: { type: 'string' },
    feedback: { type: 'object' },
    prompt: { type: 'string' },
  },
};

export async function openProposalReview(
  request: CallbackRequest,
  signal: AbortSignal,
  options: { open?: boolean; ready?: (info: { url: string; origin: string; port: number }) => void } = {},
): Promise<InteractionResponse | undefined> {
  const input = request.input as { material?: Proposal } | null;
  const proposal = input?.material;
  if (!proposal || typeof proposal.title !== 'string' || !Array.isArray(proposal.sections)
    || proposal.sections.some((section) => !section || typeof section.id !== 'string' || typeof section.text !== 'string')
    || new Set(proposal.sections.map((section) => section.id)).size !== proposal.sections.length) {
    throw new TypeError('The review needs a title and uniquely named passages.');
  }
  const directory = await mkdtemp(join(tmpdir(), 'obversa-proposal-review-'));
  try {
    await cp(new URL('./assets/', import.meta.url), directory, { recursive: true });
    await writeFile(join(directory, 'client.js'), await readFile(fileURLToPath(import.meta.resolve('@obversa/surface/client'))));
    const { result } = await runSurface({
      app: 'proposal-review',
      signal,
      open: options.open ?? true,
      ready: options.ready,
      // This caller consumes the returned object directly; a CLI can use the framed stdout instead.
      stdout: { write: () => {} },
      assets: { directory, files: {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
        '/client.js': ['client.js', 'text/javascript; charset=utf-8'],
        '/style.css': ['style.css', 'text/css; charset=utf-8'],
      } },
      api: {
        'GET /api/proposal': () => ({ body: { question: request.decisionText, proposal }, verbatim: true }),
        'POST /api/preview': ({ body }) => ({ body: composeFeedback(proposal, body), verbatim: true }),
        'POST /api/feedback': ({ body, session }) => {
          session.complete({ decision: 'changes-requested', ...composeFeedback(proposal, body) }, { verbatim: true });
          return null;
        },
        'POST /api/approve': ({ session }) => {
          session.complete({ decision: 'approved', feedback: { proposal }, prompt: 'I approve this version.' }, { verbatim: true });
          return null;
        },
      },
    });
    return result.status === 'completed' ? result.payload as unknown as InteractionResponse : undefined;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
