import { describe, expect, it } from 'vitest';

import { toolTarget } from '../src/tool-target.ts';

describe('toolTarget', () => {
  it('takes the file path for a read, edit or write', () => {
    expect(toolTarget({ file_path: 'src/a.ts' })).toBe('src/a.ts');
    expect(toolTarget({ filePath: 'README.md' })).toBe('README.md');
    expect(toolTarget({ path: 'docs/' })).toBe('docs/');
  });

  it('takes the first words of a command, cut short of a later secret', () => {
    const secretToken = 's3cr3t-token'.repeat(6);
    const withSecret = `echo start-of-command ${secretToken}`;
    const target = toolTarget({ command: withSecret });
    expect(target).toBe(`${withSecret.slice(0, 80)}…`);
    expect(target).not.toContain(secretToken);
  });

  it('takes the url, cut at its query string', () => {
    expect(toolTarget({ url: 'https://example.invalid/search?token=secret&q=x' }))
      .toBe('https://example.invalid/search');
  });

  it('takes the pattern for a search', () => {
    expect(toolTarget({ pattern: '**/*.spec.ts' })).toBe('**/*.spec.ts');
  });

  it('prefers the first key it finds, in the documented order', () => {
    expect(toolTarget({ path: 'a', pattern: 'b' })).toBe('a');
    expect(toolTarget({ command: 'a', url: 'b' })).toBe('a');
  });

  it('cuts a long value to about 80 characters with an ellipsis', () => {
    const long = 'x'.repeat(150);
    expect(toolTarget({ path: long })).toBe(`${'x'.repeat(80)}…`);
  });

  it('reports nothing for a tool whose input names none of the known arguments', () => {
    expect(toolTarget({ query: 'weather in London' })).toBeUndefined();
    expect(toolTarget({})).toBeUndefined();
  });

  it('reports nothing when the input is not an object', () => {
    expect(toolTarget(undefined)).toBeUndefined();
    expect(toolTarget(null)).toBeUndefined();
    expect(toolTarget('a string')).toBeUndefined();
    expect(toolTarget(['a', 'b'])).toBeUndefined();
  });
});
