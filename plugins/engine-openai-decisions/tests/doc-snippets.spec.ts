/**
 * Keeps the public snippets honest. Every ```ts fenced block in the README
 * and the docs page must appear verbatim in doc-snippets.ts, import line
 * included, which the package's own typecheck compiles against the real
 * exports. Every ```json block must parse as a document and translate every
 * question to the wire.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { JsonObject } from '@obversa/api';

import { parseDecisionDocument, wireQuestion } from '../src/openai-decisions.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'doc-snippets.ts'), 'utf8');
const docs: ReadonlyArray<readonly [string, string]> = [
  ['README.md', readFileSync(join(here, '..', 'README.md'), 'utf8')],
  [
    'engine-openai-decisions.mdx',
    readFileSync(join(here, '..', '..', '..', 'docs', 'public', 'packages', 'engine-openai-decisions.mdx'), 'utf8'),
  ],
];

/** Every fenced block in `lang`, skipping a block titled `Output`, which shows what an example printed. */
function fenced(source: string, lang: string): string[] {
  const blocks: string[] = [];
  const opener = new RegExp('^```' + lang + '(?: ([^\\n]*))?\\n', 'gm');
  for (const match of source.matchAll(opener)) {
    const start = match.index + match[0].length;
    const end = source.indexOf('\n```', start);
    if (end === -1) throw new Error(`a ${lang} fence at offset ${match.index} is never closed`);
    if (match[1]?.trim().startsWith('Output')) continue;
    blocks.push(source.slice(start, end));
  }
  return blocks;
}

function withoutImports(block: string): string {
  return block.split('\n').filter((line) => !line.startsWith('import ')).join('\n').trim();
}

describe('public TypeScript snippets', () => {
  for (const [name, source] of docs) {
    it(`${name} ts blocks appear verbatim in the compiled fixture`, () => {
      const blocks = fenced(source, 'ts');
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        for (const line of block.split('\n').filter((l) => l.startsWith('import '))) {
          expect(fixture).toContain(line);
        }
        expect(fixture).toContain(withoutImports(block));
      }
    });
  }
});

describe('public JSON examples', () => {
  for (const [name, source] of docs) {
    it(`${name} json blocks parse and translate every question`, () => {
      const blocks = fenced(source, 'json');
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        const document = parseDecisionDocument(block);
        for (const [question, body] of Object.entries(document.questions)) {
          expect(() => wireQuestion(question, body as JsonObject)).not.toThrow();
        }
      }
    });
  }
});
