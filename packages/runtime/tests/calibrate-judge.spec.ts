import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const tool = resolve(root, 'tools', 'calibrate-judge.mjs');
const fixture = resolve(here, 'fixtures', 'calibrate-judge.example.jsonl');

// The tuning tool asks the runtime's own score questions, so it runs against
// the built package. `pnpm build` runs before the suite.
describe('calibrate-judge', () => {
  it('--dry-run prints the planned requests and their token counts without a call', () => {
    const output = execFileSync('node', [tool, '--dry-run', fixture], { cwd: root, encoding: 'utf8' });
    expect(output).toMatch(/request 1: \d+ findings, \d+ characters, ~\d+ input tokens, questions: finding-1/);
    expect(output).toContain('1 request(s) for 8 labelled findings');
    // The dry run prints each request body it would send, then the token total.
    expect(output).toContain('request 1 body:');
    expect(output).toContain('"model": "jev-latest"');
    expect(output).toContain('"questions"');
    expect(output).toMatch(/input tokens: \d+\s*$/);
  });

  it('refuses a labelled line without the labels it needs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'calibrate-'));
    try {
      const bad = join(dir, 'bad.jsonl');
      writeFileSync(bad, '{"finding": {"evidence": "x"}}\n');
      expect(() => execFileSync('node', [tool, '--dry-run', bad], { cwd: root, encoding: 'utf8' })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
