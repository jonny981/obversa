// Annotate a parsed diff model with go-to-source hits (clickable identifiers).
//
// A diff hunk alone is not parseable, so for each JS-family file we read its
// full new-side content, index every identifier and its definition site
// (navindex), then keep only the identifiers on lines the diff actually shows
// and decide each one's click action — jump, indicate, or none (navoverlay).
// A shown line gains a `hits` array. Everything degrades quietly: a deleted,
// binary, unreadable, non-JS, or unparseable file simply gets no hits, so
// go-to-source is additive over the plain highlighted diff.
//
// v1 scope: JavaScript-family files (.js/.mjs/.cjs), worktree and staged modes.
// TypeScript and JSX parse-fail closed (no hits) until the parser covers them.

import { navIndex } from "./navindex.mjs";
import { navOverlay, visibleNewLines } from "./navoverlay.mjs";
import { langForPath } from "./lang.mjs";
import { readNewFileText } from "./git.mjs";
import { MAX_CONTEXT_TOTAL_BYTES } from "./context-model.mjs";

const NAV_LANGS = new Set(["javascript", "js", "cjs", "mjs", "jsx"]);

// Go-to-source shares the review-wide byte bound with full-file context: each
// file is read at most once for indexing and the sum is capped, so a change
// touching many large files cannot hold all of their text for the parser.
export async function navModel(model, { mode = "worktree", cwd = process.cwd(), read = readNewFileText, maxTotalBytes = MAX_CONTEXT_TOTAL_BYTES } = {}) {
  if (!model || !Array.isArray(model.files)) return;

  let totalBytes = 0;
  for (const file of model.files) {
    if (file.binary || file.hunks.length === 0) continue;
    if (!NAV_LANGS.has(langForPath(file.path))) continue;
    if (totalBytes >= maxTotalBytes) break;

    const target = file.newPath && file.newPath !== "/dev/null" ? file.newPath : file.path;
    const code = await read({ path: target, mode, cwd });
    if (typeof code !== "string" || code.length === 0) continue;
    totalBytes += Buffer.byteLength(code, "utf8");
    if (totalBytes > maxTotalBytes) break;

    const { occurrences } = navIndex({ code, lang: "javascript" });
    if (occurrences.length === 0) continue;

    const { hits } = navOverlay({ occurrences, visibleLines: visibleNewLines(file) });
    if (hits.length === 0) continue;

    const byLine = new Map();
    for (const hit of hits) {
      const bucket = byLine.get(hit.line);
      if (bucket) bucket.push(hit);
      else byLine.set(hit.line, [hit]);
    }
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.newNumber != null) {
          const bucket = byLine.get(line.newNumber);
          if (bucket) line.hits = bucket;
        }
      }
    }
  }
}
