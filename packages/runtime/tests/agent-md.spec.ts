import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineAgentFromMarkdown, LoopError } from '../src/api.ts';

// defineAgentFromMarkdown loads a Claude Code agent .md (frontmatter + body)
// into a validated AgentDef. The parser is hand-rolled and deliberately
// scoped; these tests pin the supported grammar and the AgentDef mapping.

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lines-agent-md-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixture(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe('defineAgentFromMarkdown', () => {
  it('maps full frontmatter onto an AgentDef, dropping spawn tools', () => {
    const path = fixture(
      'reviewer.md',
      [
        '---',
        'name: code-reviewer',
        'description: |',
        '  Reviews diffs for correctness.',
        '  Focused and terse.',
        'model: claude-sonnet-4-5',
        'tools: Read, Grep, Task, Bash, Agent',
        '---',
        '',
        'You review code. Be terse.',
        '',
      ].join('\n'),
    );
    const def = defineAgentFromMarkdown(path);
    expect(def.name).toBe('code-reviewer');
    expect(def.description).toBe(
      'Reviews diffs for correctness.\nFocused and terse.',
    );
    expect(def.model).toBe('claude-sonnet-4-5');
    // Task and Agent are filtered: a markdown-loaded agent is a leaf.
    expect(def.tools).toEqual(['Read', 'Grep', 'Bash']);
    expect(def.leaf).toBe(true);
    expect(def.system).toBe('You review code. Be terse.');
  });

  it('parses list-style tools', () => {
    const path = fixture(
      'lister.md',
      [
        '---',
        'tools:',
        '  - Read',
        '  - Task',
        '  - Grep',
        '---',
        'Do the work.',
      ].join('\n'),
    );
    expect(defineAgentFromMarkdown(path).tools).toEqual(['Read', 'Grep']);
  });

  it('a spawn tool cannot hide inside a multi-token item (folded/literal/quoted scalars)', () => {
    // Each of these grammar shapes yields ONE item carrying several tool
    // names. The claude CLI accepts space-separated names inside a single
    // --allowedTools value, so the filter must see individual names or a
    // folded `Read Task` would resurrect the spawn tool downstream.
    const folded = fixture(
      'folded-tools.md',
      ['---', 'tools: >', '  Read', '  Task', '---', 'Work.'].join('\n'),
    );
    expect(defineAgentFromMarkdown(folded).tools).toEqual(['Read']);

    const literal = fixture(
      'literal-tools.md',
      ['---', 'tools: |', '  Read', '  Agent', '---', 'Work.'].join('\n'),
    );
    expect(defineAgentFromMarkdown(literal).tools).toEqual(['Read']);

    const quoted = fixture(
      'quoted-tools.md',
      ['---', 'tools: "Read Task"', '---', 'Work.'].join('\n'),
    );
    expect(defineAgentFromMarkdown(quoted).tools).toEqual(['Read']);

    const quotedItem = fixture(
      'quoted-item-tools.md',
      ['---', 'tools:', '  - "Task Agent"', '  - Grep', '---', 'Work.'].join(
        '\n',
      ),
    );
    expect(defineAgentFromMarkdown(quotedItem).tools).toEqual(['Grep']);
  });

  it('a file with no frontmatter: body is the system, name from the filename', () => {
    const path = fixture('plain-worker.md', 'Just do the thing.\n');
    const def = defineAgentFromMarkdown(path);
    expect(def.name).toBe('plain-worker');
    expect(def.system).toBe('Just do the thing.');
    expect(def.leaf).toBe(true);
    expect(def.tools).toBeUndefined();
  });

  it('model: inherit (and default) map to undefined', () => {
    const inherit = fixture(
      'inherit.md',
      '---\nmodel: inherit\n---\nWork.',
    );
    const dflt = fixture('default.md', '---\nmodel: default\n---\nWork.');
    expect(defineAgentFromMarkdown(inherit).model).toBeUndefined();
    expect(defineAgentFromMarkdown(dflt).model).toBeUndefined();
  });

  it('overrides spread last, so the caller wins', () => {
    const path = fixture(
      'overridable.md',
      '---\nname: original\nmodel: claude-haiku-4-5\n---\nWork.',
    );
    const def = defineAgentFromMarkdown(path, {
      name: 'renamed',
      tier: 'reviewer',
      leaf: false,
    });
    expect(def.name).toBe('renamed');
    expect(def.tier).toBe('reviewer');
    expect(def.leaf).toBe(false);
    expect(def.model).toBe('claude-haiku-4-5');
  });

  it('a blank body throws a CONFIG error naming the path', () => {
    const path = fixture('empty.md', '---\nname: hollow\n---\n\n   \n');
    try {
      defineAgentFromMarkdown(path);
      expect.unreachable('a blank body must throw');
    } catch (e) {
      expect(e).toBeInstanceOf(LoopError);
      expect((e as LoopError).code).toBe('CONFIG');
      expect((e as LoopError).message).toContain(path);
    }
  });

  it('ignores unknown frontmatter keys (forward compat)', () => {
    const path = fixture(
      'future.md',
      [
        '---',
        'name: futuristic',
        'color: cyan',
        'proactive: true',
        'hooks:',
        '  - on-save',
        '---',
        'Work.',
      ].join('\n'),
    );
    const def = defineAgentFromMarkdown(path);
    expect(def.name).toBe('futuristic');
    expect(def.system).toBe('Work.');
    expect('color' in def).toBe(false);
  });

  it('strips surrounding quotes from scalars', () => {
    const path = fixture(
      'quoted.md',
      [
        '---',
        `name: 'quoted-agent'`,
        'description: "A quoted description"',
        '---',
        'Work.',
      ].join('\n'),
    );
    const def = defineAgentFromMarkdown(path);
    expect(def.name).toBe('quoted-agent');
    expect(def.description).toBe('A quoted description');
  });

  it('folds a > block scalar with spaces', () => {
    const path = fixture(
      'folded.md',
      [
        '---',
        'description: >',
        '  A folded',
        '  description.',
        '---',
        'Work.',
      ].join('\n'),
    );
    expect(defineAgentFromMarkdown(path).description).toBe(
      'A folded description.',
    );
  });

  it('a | block spans blank lines: multi-paragraph descriptions survive', () => {
    const path = fixture(
      'paragraphs.md',
      [
        '---',
        'description: |',
        '  First paragraph.',
        '',
        '  Second paragraph.',
        'tools: Read',
        '---',
        'Work.',
      ].join('\n'),
    );
    const def = defineAgentFromMarkdown(path);
    expect(def.description).toBe('First paragraph.\n\nSecond paragraph.');
    expect(def.tools).toEqual(['Read']);
    expect(def.system).toBe('Work.');
  });

  it('an indented --- inside a block scalar stays block content', () => {
    const path = fixture(
      'rule.md',
      [
        '---',
        'description: |',
        '  Section one.',
        '  ---',
        '  Section two.',
        'tools: Read',
        '---',
        'Real body.',
      ].join('\n'),
    );
    const def = defineAgentFromMarkdown(path);
    expect(def.description).toBe('Section one.\n---\nSection two.');
    expect(def.tools).toEqual(['Read']);
    expect(def.system).toBe('Real body.');
  });
});
