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

// A review-wide bound on full-file content. Each file is already capped per
// read; this caps the sum, so a change touching many large files cannot make
// the surface hold every file's text, tokens, and navigation at once. Files
// past the bound simply get no expandable context — the diff still renders.
// The pass below counts its own reads; the review shares one bound between
// this pass and go-to-source by handing both the same boundedReader.
export const MAX_CONTEXT_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * One reader for a whole review. Full-file context and go-to-source both read
 * a file's new side; through this reader a file is read at most once whoever
 * asks, and the bytes read are summed under one bound across both. Each read
 * is capped at what is left of the bound, so the sum never passes it, not even
 * for the read that would cross it. Past the bound every read yields null.
 */
export function boundedReader({ read = readNewFileText, maxTotalBytes = MAX_CONTEXT_TOTAL_BYTES } = {}) {
  const cache = new Map();
  let used = 0;
  return async function boundedRead({ path, mode, cwd } = {}) {
    const key = `${mode}\0${path}`;
    if (cache.has(key)) return cache.get(key);
    let text = null;
    const remaining = maxTotalBytes - used;
    if (remaining > 0) {
      const code = await read({ path, mode, cwd, maxBytes: remaining });
      if (typeof code === "string") {
        const bytes = Buffer.byteLength(code, "utf8");
        if (bytes <= remaining) {
          used += bytes;
          text = code;
        }
      }
    }
    cache.set(key, text);
    return text;
  };
}

function sliceContext(lines, tokens, from, to) {
  const out = [];
  for (let n = Math.max(1, from); n <= to; n += 1) {
    if (n > lines.length) break;
    out.push({ line: n, text: lines[n - 1] ?? "", tokens: tokens[n - 1] ?? [] });
  }
  return out;
}

export async function contextModel(model, { mode = "worktree", cwd = process.cwd(), registry, read = readNewFileText, maxTotalBytes = MAX_CONTEXT_TOTAL_BYTES } = {}) {
  if (!model || !Array.isArray(model.files) || !registry) return;

  let totalBytes = 0;
  for (const file of model.files) {
    if (file.binary || file.hunks.length === 0) continue;
    if (totalBytes >= maxTotalBytes) break;

    const target = file.newPath && file.newPath !== "/dev/null" ? file.newPath : file.path;
    const code = await read({ path: target, mode, cwd });
    if (typeof code !== "string" || code.length === 0) continue;
    totalBytes += Buffer.byteLength(code, "utf8");
    if (totalBytes > maxTotalBytes) break;

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
