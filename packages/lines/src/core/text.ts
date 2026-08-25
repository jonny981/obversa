/**
 * Shared text helpers, so the same trim/truncate logic isn't re-implemented
 * (subtly differently) across modules.
 */

/** Collapse all runs of whitespace to single spaces, and trim. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Truncate to `max` chars, appending a `\n…` marker when it overflows. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const marker = max > 1 ? '\n…' : '…'.slice(0, Math.max(0, max));
  return `${s.slice(0, Math.max(0, max - marker.length)).trimEnd()}${marker}`;
}
