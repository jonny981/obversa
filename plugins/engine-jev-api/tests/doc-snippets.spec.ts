/**
 * Keeps the public snippets honest. Every ```ts fenced block in the README
 * and the docs page must appear verbatim in doc-snippets.ts — import line
 * included — which the package's own typecheck compiles against the real
 * exports under the published package specifier. Every ```json block must
 * parse through parseJevDocument and carry criteria in the wire shapes the
 * sanitized control payload recorded: option-keyed description maps for
 * choice, a label array for score, and true/false descriptions for noul.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseJevDocument } from '../src/jev-api.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'doc-snippets.ts'), 'utf8');
const docs: ReadonlyArray<readonly [string, string]> = [
  ['README.md', readFileSync(join(here, '..', 'README.md'), 'utf8')],
  [
    'engine-jev-api.mdx',
    readFileSync(join(here, '..', '..', '..', 'docs', 'public', 'packages', 'engine-jev-api.mdx'), 'utf8'),
  ],
];

function fenced(source: string, lang: string): string[] {
  const blocks: string[] = [];
  const open = '```' + lang + '\n';
  let at = 0;
  for (;;) {
    const start = source.indexOf(open, at);
    if (start === -1) return blocks;
    const end = source.indexOf('\n```', start + open.length);
    if (end === -1) {
      throw new Error(`a ${lang} fence at offset ${start} is never closed`);
    }
    blocks.push(source.slice(start + open.length, end));
    at = end;
  }
}

function withoutImports(block: string): string {
  return block
    .split('\n')
    .filter((line) => !line.startsWith('import '))
    .join('\n')
    .trim();
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
    it(`${name} json blocks parse through parseJevDocument with wire-shaped criteria`, () => {
      const blocks = fenced(source, 'json');
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        const document = parseJevDocument(block);
        for (const [id, question] of Object.entries(document.questions)) {
          const { type, criteria } = question as { type?: unknown; criteria?: unknown };
          if (type === 'noul') {
            expect(Object.keys(criteria as object).sort()).toEqual(['false', 'true']);
            for (const value of Object.values(criteria as Record<string, unknown>)) {
              expect(typeof value).toBe('string');
            }
          } else if (type === 'choice') {
            expect(criteria).toBeTypeOf('object');
            expect(Array.isArray(criteria)).toBe(false);
            for (const value of Object.values(criteria as Record<string, unknown>)) {
              expect(typeof value).toBe('string');
            }
          } else if (type === 'score') {
            expect(Array.isArray(criteria)).toBe(true);
            for (const label of criteria as unknown[]) {
              expect(typeof label).toBe('string');
            }
          } else {
            throw new Error(`doc example ${id} names an untested type`);
          }
          const raw = JSON.parse(block) as { questions: Record<string, { criteria: unknown }> };
          expect(criteria).toEqual(raw.questions[id]?.criteria);
        }
      }
    });
  }
});
