/**
 * `defineAgentFromMarkdown(path)` — load a Claude Code agent `.md` file into an
 * `AgentDef`. The markdown body becomes `system`; the frontmatter maps onto the
 * def's structured fields. The runtime has no yaml dependency, so the frontmatter
 * parser is hand-rolled and deliberately scoped. The FULL supported grammar:
 *
 *   - Frontmatter is an optional leading block delimited by `---` lines (the
 *     first line of the file opens it; the closing `---` must be unindented,
 *     so an indented `---` inside a block scalar stays block content). No
 *     closing `---` ⇒ no frontmatter; the whole file is the body.
 *   - Scalar: `key: value`. Surrounding single/double quotes are stripped.
 *   - Block scalar: `key: |` or `key: >`, then deeper-indented lines, each
 *     trimmed. The block ends at the first non-indented, non-blank line; blank
 *     lines inside it (followed by more indented content) are kept by `|` as
 *     paragraph breaks and folded away by `>`. `|` joins the lines with
 *     newlines; `>` folds them with spaces (YAML's basic folding, nothing
 *     more).
 *   - Sequence: `key:` alone, then `- item` lines (quotes stripped per item).
 *   - `tools` specifically: a scalar value is ALSO split on commas into a list
 *     (`tools: Read, Grep, Bash` ⇒ `['Read', 'Grep', 'Bash']`).
 *
 * Anything else (nested maps, anchors, multi-line flow, comments…) is out of
 * scope BY DESIGN, not a bug: Claude Code agent files use exactly this shape.
 * Unknown frontmatter keys are ignored (forward compat with CC's evolving
 * frontmatter), not errors.
 */

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineAgent, type AgentDef } from './agent.js';
import { LoopError } from './errors.js';
import { SUBAGENT_TOOLS } from '../engines/engine.js';

type Frontmatter = Record<string, string | string[]>;

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"')))
  )
    return value.slice(1, -1);
  return value;
}

/** Split a file into its frontmatter fields and its body. */
function splitDocument(source: string): { fm: Frontmatter; body: string } {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { fm: {}, body: source };
  // Only an unindented `---` closes the frontmatter: an indented one is
  // block-scalar content (YAML document markers are column-0 only).
  const close = lines.findIndex((l, i) => i > 0 && /^---\s*$/.test(l));
  if (close < 0) return { fm: {}, body: source };
  return {
    fm: parseFrontmatter(lines.slice(1, close)),
    body: lines.slice(close + 1).join('\n'),
  };
}

function parseFrontmatter(lines: string[]): Frontmatter {
  const out: Frontmatter = {};
  let i = 0;
  while (i < lines.length) {
    const m = /^(\S[^:]*):(.*)$/.exec(lines[i]!);
    if (!m) {
      i++; // blank or out-of-grammar line: ignored
      continue;
    }
    const key = m[1]!.trim();
    const rest = m[2]!.trim();
    i++;
    if (rest === '|' || rest === '>') {
      const block: string[] = [];
      while (i < lines.length) {
        if (/^\s+\S/.test(lines[i]!)) {
          block.push(lines[i]!.trim());
          i++;
          continue;
        }
        // Blank lines belong to the block only when more indented content
        // follows (a multi-paragraph description); otherwise the block ends.
        let j = i;
        while (j < lines.length && lines[j]!.trim() === '') j++;
        if (j === i || j >= lines.length || !/^\s+\S/.test(lines[j]!)) break;
        while (i < j) {
          block.push('');
          i++;
        }
      }
      out[key] =
        rest === '|' ? block.join('\n') : block.filter(Boolean).join(' ');
    } else if (rest === '') {
      const items: string[] = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i]!)) {
        items.push(unquote(lines[i]!.replace(/^\s*-\s+/, '').trim()));
        i++;
      }
      if (items.length) out[key] = items;
    } else {
      out[key] = unquote(rest);
    }
  }
  return out;
}

/** Sub-agent spawn tools, dropped from a markdown agent's allowlist (case-sensitive:
 *  CC tool names are case-sensitive, so `task` would be a different tool). The set is
 *  the engines' own `SUBAGENT_TOOLS`, so the loader filter and the engine-side leaf
 *  backstop (`--disallowedTools`) can never disagree. */
const SPAWN_TOOLS = new Set(SUBAGENT_TOOLS);

function toTools(value: string | string[] | undefined): string[] | undefined {
  if (value == null) return undefined;
  const items = Array.isArray(value) ? value : [value];
  // Split every item on commas AND whitespace: the frontmatter grammar can fold
  // several names into ONE item (a `>`/`|` block scalar, a quoted "Read Task"),
  // and the claude CLI accepts space-separated names inside a single
  // --allowedTools value — so a multi-token item surviving the filter would
  // resurrect a spawn tool downstream. Filtering must see individual names.
  const list = items.flatMap((item) => item.split(/[\s,]+/));
  return list.filter((t) => t && !SPAWN_TOOLS.has(t));
}

/**
 * Load a Claude Code agent `.md` into an `AgentDef` (validated through
 * `defineAgent`). The body is the `system`; `name` falls back to the file's
 * basename; `model: inherit`/`default` map to undefined (inherit the run
 * default). The result is always a leaf — a markdown-loaded agent has no
 * sub-agents by construction, and dropping Task/Agent from `tools` is the
 * same statement. `overrides` spread last, so the caller wins.
 */
export function defineAgentFromMarkdown(
  path: string | URL,
  overrides?: Partial<AgentDef>,
): AgentDef {
  const filePath = typeof path === 'string' ? path : fileURLToPath(path);
  const { fm, body } = splitDocument(readFileSync(filePath, 'utf8'));

  const name =
    typeof fm.name === 'string' && fm.name
      ? fm.name
      : basename(filePath, extname(filePath));
  const description =
    typeof fm.description === 'string' ? fm.description : undefined;
  const model =
    typeof fm.model === 'string' && fm.model !== 'inherit' && fm.model !== 'default'
      ? fm.model
      : undefined;

  const def: AgentDef = {
    name,
    ...(description ? { description } : {}),
    ...(model ? { model } : {}),
    ...(fm.tools != null ? { tools: toTools(fm.tools) } : {}),
    system: body.trim(),
    leaf: true,
    ...overrides,
  };
  if (!def.system?.trim())
    throw new LoopError({
      code: 'CONFIG',
      message: `defineAgentFromMarkdown: "${filePath}" has an empty body — the markdown body (after any frontmatter) becomes the agent's system prompt`,
    });
  return defineAgent(def);
}
