// Parse the output of `git diff` (default unified format) into a structured
// model the review page can render and anchor comments to. It handles many
// files in one diff, added/deleted/renamed/copied/binary files, hunk headers
// with or without a line count, and the "\ No newline at end of file" marker.
// It does not handle combined merge diffs, colour codes, or word diffs — plain
// `git diff` only.

// Git wraps a path in double quotes and C-escapes it when the path contains a
// control character, a double quote, or a backslash. With core.quotePath=false
// (set by the caller) non-ASCII bytes stay literal, so only these C escapes
// remain. Decode them so a filename with, say, a tab yields the real path a
// responder can locate — not the literal quoted form.
function unquoteGitPath(raw) {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  const inner = raw.slice(1, -1);
  const escapes = { t: 9, n: 10, r: 13, f: 12, b: 8, v: 11, a: 7 };
  let out = "";
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i] !== "\\") { out += inner[i]; continue; }
    const next = inner[i + 1];
    if (next === undefined) { out += "\\"; break; }
    if (Object.hasOwn(escapes, next)) { out += String.fromCharCode(escapes[next]); i += 1; continue; }
    out += next; // \" -> ", \\ -> \, any other escaped char stays literal
    i += 1;
  }
  return out;
}

function stripPathPrefix(raw) {
  const value = unquoteGitPath(raw);
  if (value.startsWith("a/") || value.startsWith("b/")) return value.slice(2);
  return value;
}

function displayPath(file) {
  return file.newPath && file.newPath !== "/dev/null" ? file.newPath : file.oldPath;
}

export function parseUnifiedDiff(diffText) {
  const files = [];
  if (typeof diffText !== "string" || diffText.length === 0) return { files };

  const lines = diffText.split("\n");
  let file = null;
  let hunk = null;
  let oldNumber = 0;
  let newNumber = 0;
  // Lines still owed by the current hunk on each side, from its header. While
  // either is positive, every line is hunk content whatever it starts with.
  let remainingOld = 0;
  let remainingNew = 0;

  const startFile = (oldPath, newPath) => {
    file = { oldPath, newPath, path: newPath || oldPath, status: "modified", binary: false, hunks: [] };
    files.push(file);
    hunk = null;
    remainingOld = 0;
    remainingNew = 0;
  };

  for (const line of lines) {
    if (hunk !== null && (remainingOld > 0 || remainingNew > 0)) {
      // Inside a hunk the header checks below must not run: a deleted
      // "-- comment" arrives as "--- comment" and an added "++ i;" as "+++ i;",
      // and treating either as a file header would drop the line, rewrite the
      // path, and shift every later anchor. Only the leading marker counts.
      if (line.startsWith("\\")) continue; // "\ No newline at end of file"
      const marker = line[0];
      if (marker === "+") {
        hunk.lines.push({ type: "add", oldNumber: null, newNumber, text: line.slice(1) });
        newNumber += 1;
        remainingNew -= 1;
      } else if (marker === "-") {
        hunk.lines.push({ type: "del", oldNumber, newNumber: null, text: line.slice(1) });
        oldNumber += 1;
        remainingOld -= 1;
      } else if (marker === " " || line === "") {
        // A blank context line is a single space; git's suppressBlankEmpty
        // emits an empty line instead, which means the same thing.
        hunk.lines.push({ type: "context", oldNumber, newNumber, text: line.slice(1) });
        oldNumber += 1;
        newNumber += 1;
        remainingOld -= 1;
        remainingNew -= 1;
      } else {
        // Not a diff line: the hunk is malformed; stop reading it.
        hunk = null;
        remainingOld = 0;
        remainingNew = 0;
      }
      continue;
    }

    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      startFile(match ? match[1] : "", match ? match[2] : "");
      continue;
    }
    if (!file) continue; // ignore any preamble before the first file header

    if (line.startsWith("new file mode")) { file.status = "added"; continue; }
    if (line.startsWith("deleted file mode")) { file.status = "deleted"; continue; }
    if (line.startsWith("rename from ")) { file.status = "renamed"; file.oldPath = unquoteGitPath(line.slice(12)); file.path = displayPath(file); continue; }
    if (line.startsWith("rename to ")) { file.status = "renamed"; file.newPath = unquoteGitPath(line.slice(10)); file.path = displayPath(file); continue; }
    if (line.startsWith("copy from ")) { file.status = "copied"; file.oldPath = unquoteGitPath(line.slice(10)); file.path = displayPath(file); continue; }
    if (line.startsWith("copy to ")) { file.status = "copied"; file.newPath = unquoteGitPath(line.slice(8)); file.path = displayPath(file); continue; }
    if (line.startsWith("Binary files ")) { file.binary = true; continue; }

    if (line.startsWith("--- ")) {
      const value = line.slice(4);
      file.oldPath = value === "/dev/null" ? "/dev/null" : stripPathPrefix(value);
      if (file.newPath === "/dev/null" && file.status === "modified") file.status = "deleted";
      file.path = displayPath(file);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const value = line.slice(4);
      file.newPath = value === "/dev/null" ? "/dev/null" : stripPathPrefix(value);
      if (file.oldPath === "/dev/null" && file.status === "modified") file.status = "added";
      file.path = displayPath(file);
      continue;
    }

    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (header) {
      hunk = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        header: header[5].trim(),
        lines: [],
      };
      file.hunks.push(hunk);
      oldNumber = hunk.oldStart;
      newNumber = hunk.newStart;
      remainingOld = hunk.oldLines;
      remainingNew = hunk.newLines;
      continue;
    }

    if (line.startsWith("\\")) continue; // "\ No newline at end of file" after a spent hunk
    // Anything else after a hunk's counts are spent (the trailing empty split
    // element at EOF, index/mode lines) ends the hunk region without content.
    hunk = null;
  }

  return { files };
}
