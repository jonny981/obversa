// Overlay go-to-source hits onto a line's highlight tokens, producing render
// segments. Each token is split at any hit's column boundaries, so a clickable
// identifier becomes its own segment (carrying the hit) while the surrounding
// syntax keeps its highlight class. app.js turns each segment into a span — a
// hit segment into an interactive one — and this runs the same way in a node
// test, which is the point: the column arithmetic (shiki token widths vs the
// navindex/acorn occurrence columns, both 0-based UTF-16 code units) is the only
// place this can go wrong, so it is pure and tested rather than only visible in
// a browser.
//
// Concatenating the segment texts always reproduces the line exactly, whatever
// the token/hit boundaries; a hit that spans more than one token yields a hit
// segment per token (each clickable), which is rare and harmless.

export function overlaySegments(tokens, hits) {
  const out = [];
  if (!Array.isArray(tokens)) return out;
  const clickable = (Array.isArray(hits) ? hits : []).filter(
    (hit) => hit && hit.action && hit.action !== "none",
  );

  let col = 0;
  for (const token of tokens) {
    const text = typeof token?.text === "string" ? token.text : "";
    const start = col;
    const end = col + text.length;
    col = end;
    if (text.length === 0) continue;
    const cls = token?.cls ?? null;

    const overlaps = clickable
      .filter((hit) => hit.col < end && hit.endCol > start)
      .sort((a, b) => a.col - b.col);
    if (overlaps.length === 0) {
      out.push({ text, cls });
      continue;
    }

    let pos = start;
    for (const hit of overlaps) {
      const hitStart = Math.max(hit.col, start);
      const hitEnd = Math.min(hit.endCol, end);
      if (hitEnd <= pos) continue; // covered by an earlier overlapping hit
      if (hitStart > pos) out.push({ text: text.slice(pos - start, hitStart - start), cls });
      out.push({ text: text.slice(hitStart - start, hitEnd - start), cls, hit });
      pos = hitEnd;
    }
    if (pos < end) out.push({ text: text.slice(pos - start), cls });
  }
  return out;
}
