import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { LoopEvent } from '../src/core/types.js';
import {
  formatDuration,
  readRecordFile,
  renderRecord,
  summarizeRecord,
} from '../src/runtime/render-record.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, 'fixtures', 'public-docs-writer.record.jsonl');
const distBin = join(here, '..', 'dist', 'bin', 'record.js');

const fixture = readRecordFile(fixturePath);

describe('summarizeRecord on a real record', () => {
  const summary = summarizeRecord(fixture.events);

  it('reads the header', () => {
    expect(summary.name).toBe('public-docs-writer');
    expect(summary.startedAt).toBe(1790525353006);
    expect(summary.endedAt).toBeNull();
    expect(summary.outcome).toBeNull();
    expect(summary.monitor).toBe('http://127.0.0.1:54312/');
    expect(summary.usage).toEqual({
      inputTokens: 1911281,
      outputTokens: 17845,
      cacheReadInputTokens: 1761466,
      unmeasuredCalls: 0,
    });
  });

  it('groups the nodes and their runs', () => {
    expect(summary.nodes.map((n) => n.node)).toEqual([
      'write',
      'read',
      'judge',
      'route',
      'approve',
    ]);
    expect(summary.nodes.map((n) => n.runs.length)).toEqual([3, 2, 2, 2, 2]);
  });

  it('folds engine calls and tools into the run', () => {
    const write = summary.nodes[0]!;
    expect(write.runs[0]!.engineCalls).toEqual([
      { model: 'claude-sonnet-4-5-20250929', inputTokens: 802624, outputTokens: 7903 },
    ]);
    expect(write.runs[0]!.tools).toEqual([
      { name: 'Read', count: 3, targets: [] },
      { name: 'Edit', count: 3, targets: [] },
      { name: 'bash', count: 1, targets: [] },
    ]);
  });

  it('attaches the kickback to the run it caused', () => {
    const write = summary.nodes[0]!;
    expect(write.runs[1]!.kickback).toMatchObject({
      from: 'route',
      to: 'write',
      count: 1,
      limit: 6,
      accepted: true,
      reason: 'round 1: the judge says another round is worth it (0.63); 6 block, 4 should, 0 nit',
    });
    expect(write.runs[2]!.kickback?.count).toBe(2);
  });

  it('records a killed run and an approve that only has its done', () => {
    const write = summary.nodes[0]!;
    expect(typeof write.runs[2]!.startedAt).toBe('number');
    expect(write.runs[2]!.endedAt).toBeNull();
    const approve = summary.nodes[4]!;
    expect(approve.runs[0]!.outcome?.status).toBe('aborted');
    expect(approve.runs[0]!.startedAt).toBeNull();
  });
});

describe('renderRecord on a real record', () => {
  const markdown = renderRecord(fixture.events);

  it('renders the header and every node section', () => {
    expect(markdown.startsWith('# public-docs-writer\n')).toBe(true);
    expect(markdown.split('\n').filter((l) => l.startsWith('## ')).length).toBe(5);
    expect(markdown.split('\n').filter((l) => l.startsWith('### Run ')).length).toBe(11);
    const started = `2026-09-28 09:29:13`;
    expect(
      `\n- Started ${started} UTC. No end recorded.\n`.replace(
        started,
        new Date(1790525353006).toISOString().slice(0, 19).replace('T', ' '),
      ),
    ).toBe(`\n- Started ${new Date(1790525353006).toISOString().slice(0, 19).replace('T', ' ')} UTC. No end recorded.\n`);
    expect(markdown).toContain(
      `\n- Started ${new Date(1790525353006).toISOString().slice(0, 19).replace('T', ' ')} UTC. No end recorded.\n`,
    );
    expect(markdown).toContain(
      '- Tokens: 1,911,281 in, 17,845 out, 1,761,466 read from cache.',
    );
    expect(markdown).toContain('- Monitor: http://127.0.0.1:54312/');
  });

  it('renders run headings with duration from the record', () => {
    const writeStart = fixture.events.find(
      (e) => e.kind === 'dag:node' && e.node === 'write' && e.phase === 'start' && e.attempt === 1,
    );
    const writeDone = fixture.events.find(
      (e) => e.kind === 'dag:node' && e.node === 'write' && e.phase === 'done' && e.attempt === 1,
    );
    const duration = formatDuration((writeDone?.ts ?? 0) - (writeStart?.ts ?? 0));
    const startClock = new Date(writeStart?.ts ?? 0).toISOString().slice(11, 19);
    expect(markdown).toContain(`### Run 1 — pass, ${duration}, started ${startClock}`);
    expect(markdown).toContain('### Run 3 — no end recorded, started ');
  });

  it('prints the kickback before the run it caused', () => {
    expect(markdown).toContain(
      '\nKickback from route, 1 of 6: round 1: the judge says another round is worth it (0.63); 6 block, 4 should, 0 nit\n',
    );
    expect(markdown).toContain(
      'Kickback from route, 2 of 6: round 2: the judge says another round is worth it (0.63); 3 block, 7 should, 0 nit',
    );
    const writeSection = markdown.slice(markdown.indexOf('## write'));
    const run1 = writeSection.indexOf('### Run 1');
    const kick = writeSection.indexOf('Kickback from route, 1 of 6');
    const run2 = writeSection.indexOf('### Run 2');
    expect(run1).toBeGreaterThanOrEqual(0);
    expect(kick).toBeGreaterThan(run1);
    expect(run2).toBeGreaterThan(kick);
  });

  it('strips a leading list marker from a summary', () => {
    expect(markdown).toContain('\n[block] “Each one either approves');
  });

  it('folds tools and prints the summary line', () => {
    expect(markdown).toContain('- Read ×3, Edit ×3, bash ×1');
    expect(markdown).toContain(
      '\nDone. The page now reads as you would explain it to a colleague. Key changes:\n',
    );
  });

  it('keeps lines inside the width except pauses and kickbacks', () => {
    for (const line of markdown.split('\n')) {
      if (line.startsWith('Kickback') || line.startsWith('- Paused')) continue;
      expect(line.length).toBeLessThanOrEqual(200);
    }
    expect(markdown.endsWith('\n')).toBe(true);
  });
});

describe('renderRecord on a synthetic record', () => {
  const ts = 1790525353006;
  const events = [
    { kind: 'dag:start', ts, path: ['t'], depth: 1, nodes: ['approve'] },
    { kind: 'dag:node', ts: ts + 1, path: ['t'], node: 'approve', phase: 'start', attempt: 1 },
    { kind: 'job:start', ts: ts + 2, path: ['t', 'approve'], label: 'approve' },
    {
      kind: 'job:end',
      ts: ts + 3,
      path: ['t', 'approve'],
      label: 'approve',
      outcome: {
        status: 'paused',
        summary:
          'waiting for a person: Keep docs/page.md as it now stands (sha256 abc123def456)? A no with a note sends the note to the writer.',
      },
    },
    {
      kind: 'limit:pause',
      ts: ts + 4,
      path: ['t', 'approve'],
      code: 'RATE_LIMIT',
      reason: 'the rate limit resets tomorrow',
    },
    {
      kind: 'dag:node',
      ts: ts + 45,
      path: ['t', 'approve', 'inner'],
      node: 'step',
      phase: 'skip',
      outcome: { status: 'pass', summary: 'the gate did not need it' },
    },
    { kind: 'made-up', ts: ts + 5, path: ['t', 'approve'] },
    {
      kind: 'dag:node',
      ts: ts + 6,
      path: ['t'],
      node: 'approve',
      phase: 'done',
      attempt: 1,
      outcome: {
        status: 'paused',
        summary:
          'waiting for a person: Keep docs/page.md as it now stands (sha256 abc123def456)? A no with a note sends the note to the writer.',
      },
    },
    {
      kind: 'dag:node',
      ts: ts + 8,
      path: ['t'],
      node: 'cleanup',
      phase: 'skip',
      attempt: 1,
      outcome: { status: 'pass', summary: 'its gate was unmet' },
    },
    { kind: 'made-up-root', ts: ts + 7, path: [] },
  ] as unknown as LoopEvent[];

  it('shows the pause, the limit wait, and unknown kinds', () => {
    const markdown = renderRecord(events);
    expect(markdown).toContain(
      '- Paused: waiting for a person: Keep docs/page.md as it now stands (sha256 abc123def456)? A no with a note sends the note to the writer.',
    );
    expect(markdown).toContain('- Paused (RATE_LIMIT): the rate limit resets tomorrow');
    expect(markdown).toContain('\n- made-up\n');
    expect(markdown).toContain('\n- made-up-root\n');
    expect(markdown.startsWith('# t\n')).toBe(true);
  });

  it('renders a top-level skip as skipped and a nested skip as a line', () => {
    const markdown = renderRecord(events);
    expect(markdown).toContain('\n## cleanup\n');
    expect(markdown).toContain('### Run 1 — skipped, ');
    expect(markdown).toContain('- inner/step: skipped — the gate did not need it');
  });
});

describe('summarizeRecord with a run:end', () => {
  it('takes the header usage and outcome from run:end', () => {
    const ts = 1790525353006;
    const events = [
      { kind: 'run:start', ts, path: [], runId: 'demo-run' },
      {
        kind: 'run:end',
        ts: ts + 5000,
        path: [],
        outcome: { status: 'pass', summary: 'all done' },
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ] as unknown as LoopEvent[];
    const summary = summarizeRecord(events);
    expect(summary.name).toBe('demo-run');
    expect(summary.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      unmeasuredCalls: 0,
    });
    const markdown = renderRecord(events);
    expect(markdown).toContain(
      `after ${formatDuration(5000)}: pass — all done.`,
    );
  });
});

describe('readRecordFile', () => {
  it('reads the fixture', () => {
    const { events, unreadable } = readRecordFile(fixturePath);
    expect(events.length).toBe(85);
    expect(unreadable).toBe(0);
  });

  it('counts lines that are not JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'record-'));
    try {
      const file = join(dir, 'record.jsonl');
      writeFileSync(
        file,
        '{"kind":"monitor","ts":1,"path":[],"url":"u"}\nnot json\n\n{"kind":"dag:end","ts":2,"path":[],"outcome":{"status":"pass"}}\n',
      );
      const { events, unreadable } = readRecordFile(file);
      expect(events.length).toBe(2);
      expect(unreadable).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('obversa-record bin', () => {
  it.skipIf(!existsSync(distBin))('prints the Markdown for a record', () => {
    const run = spawnSync('node', [distBin, fixturePath], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout.startsWith('# public-docs-writer')).toBe(true);
  });

  it.skipIf(!existsSync(distBin))('prints the summary as JSON with --json', () => {
    const run = spawnSync('node', [distBin, fixturePath, '--json'], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as { name: string };
    expect(parsed.name).toBe('public-docs-writer');
  });

  it.skipIf(!existsSync(distBin))('prints usage and exits 1 with no path', () => {
    const run = spawnSync('node', [distBin], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('usage: obversa-record');
  });
});
