// Click map for the review surface. Takes a full-file navindex plus the
// new-side line numbers that the diff actually shows. The browser only
// receives this JSON; it does not parse.

/**
 * New-side line numbers visible in one parsed diff file.
 * `file` matches packages/source parseUnifiedDiff: hunks[].lines[].newNumber
 * (null on deletions).
 * @param {{ hunks?: Array<{ lines?: Array<{ newNumber: number | null }> }> }} file
 * @returns {Set<number>}
 */
export function visibleNewLines(file) {
  const visible = new Set();
  for (const hunk of file?.hunks ?? []) {
    for (const line of hunk?.lines ?? []) {
      if (line?.newNumber != null) visible.add(line.newNumber);
    }
  }
  return visible;
}

/**
 * @param {{
 *   occurrences: Array<{
 *     line: number, col: number, endCol: number, name: string,
 *     kind: string, isDef: boolean, def: { line: number, col: number } | null
 *   }>,
 *   visibleLines: Iterable<number>
 * }} input
 * @returns {{ hits: Array<{
 *   line: number, col: number, endCol: number, name: string, kind: string,
 *   isDef: boolean, def: { line: number, col: number } | null,
 *   defVisible: boolean, action: 'jump' | 'indicate' | 'none'
 * }> }}
 */
export function navOverlay({ occurrences, visibleLines }) {
  if (!Array.isArray(occurrences)) throw new TypeError("occurrences must be an array");
  const visible = visibleLines instanceof Set ? visibleLines : new Set(visibleLines ?? []);
  const hits = [];
  for (const occ of occurrences) {
    if (!visible.has(occ.line)) continue;
    const defVisible = Boolean(occ.def && visible.has(occ.def.line));
    hits.push({
      line: occ.line,
      col: occ.col,
      endCol: occ.endCol,
      name: occ.name,
      kind: occ.kind,
      isDef: occ.isDef,
      def: occ.def,
      defVisible,
      action: occ.def == null ? "none" : defVisible ? "jump" : "indicate",
    });
  }
  return { hits };
}
