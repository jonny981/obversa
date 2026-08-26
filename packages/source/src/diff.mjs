// Parse the output of `git diff` (default unified format) into a structured
// model the review page can render and anchor comments to. It handles many
// files in one diff, added/deleted/renamed/copied/binary files, hunk headers
// with or without a line count, and the "\ No newline at end of file" marker.
// It does not handle combined merge diffs, colour codes, or word diffs — plain
// `git diff` only.

function stripPathPrefix(raw) {
  let value = raw;
  const tab = value.indexOf("\t"); // some git configs append a tab + timestamp
  if (tab >= 0) value = value.slice(0, tab);
  if (value.startsWith("a/") || value.startsWith("b/")) value = value.slice(2);
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

  const startFile = (oldPath, newPath) => {
    file = { oldPath, newPath, path: newPath || oldPath, status: "modified", binary: false, hunks: [] };
    files.push(file);
    hunk = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      startFile(match ? match[1] : "", match ? match[2] : "");
      continue;
    }
    if (!file) continue; // ignore any preamble before the first file header

    if (line.startsWith("new file mode")) { file.status = "added"; continue; }
    if (line.startsWith("deleted file mode")) { file.status = "deleted"; continue; }
    if (line.startsWith("rename from ")) { file.status = "renamed"; file.oldPath = line.slice(12); file.path = displayPath(file); continue; }
    if (line.startsWith("rename to ")) { file.status = "renamed"; file.newPath = line.slice(10); file.path = displayPath(file); continue; }
    if (line.startsWith("copy from ")) { file.status = "copied"; file.oldPath = line.slice(10); file.path = displayPath(file); continue; }
    if (line.startsWith("copy to ")) { file.status = "copied"; file.newPath = line.slice(8); file.path = displayPath(file); continue; }
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
      continue;
    }

    if (!hunk) continue; // index/mode lines between the file header and the first hunk
    if (line.startsWith("\\")) continue; // "\ No newline at end of file": not a content line

    const marker = line[0];
    if (marker === "+") {
      hunk.lines.push({ type: "add", oldNumber: null, newNumber, text: line.slice(1) });
      newNumber += 1;
    } else if (marker === "-") {
      hunk.lines.push({ type: "del", oldNumber, newNumber: null, text: line.slice(1) });
      oldNumber += 1;
    } else if (marker === " ") {
      hunk.lines.push({ type: "context", oldNumber, newNumber, text: line.slice(1) });
      oldNumber += 1;
      newNumber += 1;
    } else {
      // A blank line (the trailing split element at EOF) or any non-diff line
      // ends the current hunk region without adding content.
      hunk = null;
    }
  }

  return { files };
}
