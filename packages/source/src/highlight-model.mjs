// Annotate a parsed diff model with per-line syntax-highlight tokens, and return
// the single stylesheet for the whole review.
//
// Each hunk is highlighted per side — the new side is its add + context lines,
// the old side its del + context lines — so a multi-line construct inside a hunk
// keeps continuous colour. One shared registry keeps class ids consistent across
// every hunk and file, so the review serves exactly one stylesheet. Each content
// line gains a `tokens` array (see highlight.mjs); binary files and hunkless
// files are left untouched.
//
// Fidelity note: a construct that opens before a hunk (a block comment or
// template string in unchanged code above it) is not seen here, so its hunk
// lines highlight as if outside it. Correct within a hunk; the full-file-context
// upgrade would need the whole file's bytes, which the diff alone does not carry.

import { createHighlightRegistry, highlightInto } from "./highlight.mjs";
import { langForPath } from "./lang.mjs";

// Highlight the diff hunks per side into `registry` (shared with the context
// model so one stylesheet covers the diff and the expanded full-file context).
// Returns the registry; the caller turns it into CSS with registryToCss.
export async function highlightModel(model, registry = createHighlightRegistry()) {
  if (!model || !Array.isArray(model.files)) return registry;

  for (const file of model.files) {
    if (file.binary || file.hunks.length === 0) continue;
    const lang = langForPath(file.path);

    for (const hunk of file.hunks) {
      const newLines = hunk.lines.filter((line) => line.type !== "del");
      const oldLines = hunk.lines.filter((line) => line.type !== "add");
      const newTokens = newLines.length
        ? await highlightInto(registry, { code: newLines.map((line) => line.text).join("\n"), lang })
        : [];
      const oldTokens = oldLines.length
        ? await highlightInto(registry, { code: oldLines.map((line) => line.text).join("\n"), lang })
        : [];

      let ni = 0;
      let oi = 0;
      for (const line of hunk.lines) {
        if (line.type === "add") {
          line.tokens = newTokens[ni++] ?? [];
        } else if (line.type === "del") {
          line.tokens = oldTokens[oi++] ?? [];
        } else {
          // A context line is the same text on both sides; paint it from the new
          // side and advance both cursors.
          line.tokens = newTokens[ni++] ?? [];
          oi += 1;
        }
      }
    }
  }

  return registry;
}
