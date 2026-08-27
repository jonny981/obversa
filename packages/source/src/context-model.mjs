// Attach the unmodified new-side lines around each hunk, so the reviewer can
// expand "N unmodified lines" bands into full-file context — diff by default,
// the whole file a click away.
//
// For each file we read the full new-side content and highlight it once into the
// shared registry (so the context colours match the diff's), then use the hunks'
// new-side line ranges to collect the gaps: above the first hunk, between hunks,
// and below the last. A hunk gains `contextBefore` (the gap just above it) and
// the file gains `contextAfter` (below the last hunk); each is an array of
// { line, text, tokens }. Everything degrades to no context when the file can't
// be read (deleted, binary, non-readable, or range mode).

import { highlightInto } from "./highlight.mjs";
import { langForPath } from "./lang.mjs";
import { readNewFileText } from "./git.mjs";

function sliceContext(lines, tokens, from, to) {
  const out = [];
  for (let n = Math.max(1, from); n <= to; n += 1) {
    if (n > lines.length) break;
    out.push({ line: n, text: lines[n - 1] ?? "", tokens: tokens[n - 1] ?? [] });
  }
  return out;
}

export async function contextModel(model, { mode = "worktree", cwd = process.cwd(), registry, read = readNewFileText } = {}) {
  if (!model || !Array.isArray(model.files) || !registry) return;

  for (const file of model.files) {
    if (file.binary || file.hunks.length === 0) continue;

    const target = file.newPath && file.newPath !== "/dev/null" ? file.newPath : file.path;
    const code = await read({ path: target, mode, cwd });
    if (typeof code !== "string" || code.length === 0) continue;

    const lines = code.split("\n");
    // A trailing newline yields a final "" element that is not a real line.
    const total = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
    if (total === 0) continue;

    const tokens = await highlightInto(registry, { code, lang: langForPath(file.path) });

    let shownThrough = 0; // last new-side line already covered by a hunk
    for (const hunk of file.hunks) {
      hunk.contextBefore = sliceContext(lines, tokens, shownThrough + 1, hunk.newStart - 1);
      shownThrough = Math.max(shownThrough, hunk.newStart + hunk.newLines - 1);
    }
    file.contextAfter = sliceContext(lines, tokens, shownThrough + 1, total);
  }
}
