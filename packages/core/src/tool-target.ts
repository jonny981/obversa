/**
 * The one argument from a tool call's input worth putting on a line: the
 * file it read or wrote, the command it ran, the URL it fetched, or the
 * pattern it searched for. Shared by every engine plugin that reads a tool's
 * raw input, so the same five field names and the same cut are checked the
 * same way everywhere, rather than each adapter guessing its own.
 *
 * The field names cover both the Anthropic-style snake_case schema (Claude,
 * Grok) and OpenCode's own camelCase `filePath`, verified against each
 * plugin's own test fixtures rather than assumed from one of them.
 */

const TARGET_KEYS = ['file_path', 'filePath', 'path', 'command', 'url', 'pattern'] as const;

const MAX_TARGET_LENGTH = 80;

function cut(value: string, maxLen: number): string {
  return value.length > maxLen ? `${value.slice(0, maxLen)}…` : value;
}

/**
 * `input` is a tool call's raw argument object, read exactly as the engine's
 * own transcript already carries it. Returns `undefined` when it is not an
 * object or carries none of the known argument names: a tool with no file,
 * command, URL or pattern argument gets no target, rather than a guess.
 */
export function toolTarget(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (typeof value !== 'string' || value === '') continue;
    // A command's later words can carry a secret (a token passed as an
    // argument), so it is cut short like everything else rather than shown
    // in full; a URL's query string can carry one too, so that goes first.
    const base = key === 'url' ? (value.split('?')[0] ?? value) : value;
    return cut(base, MAX_TARGET_LENGTH);
  }
  return undefined;
}
