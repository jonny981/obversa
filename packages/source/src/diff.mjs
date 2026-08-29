// Parse the output of `git diff` (default unified format) into a structured
// model the review page can render and anchor comments to. It handles many
// files in one diff, added/deleted/renamed/copied/binary files, hunk headers
// with or without a line count, and the "\ No newline at end of file" marker.
// It does not handle combined merge diffs, colour codes, or word diffs — plain
// `git diff` only.

// Git wraps a path in double quotes and C-escapes it when the path contains a
// control character, a double quote, or a backslash: the named escapes for
// the usual control characters, and a 1–3 digit octal escape for any other
// byte (a control byte with no name, or — with core.quotePath on — a non-ASCII
// byte). With core.quotePath=false (set by the caller) non-ASCII bytes stay
// literal. Decode at the byte level, so an octal escape yields the real byte
// and a UTF-8 sequence spelled out in octal still decodes to its character.
function unquoteGitPath(raw) {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw;
  // Walk code points, not UTF-16 units: a character outside the BMP (an
  // emoji) is one code point but two units, and encoding each unit alone
  // would turn it into two replacement characters.
  const chars = Array.from(raw.slice(1, -1));
  const escapes = { t: 9, n: 10, r: 13, f: 12, b: 8, v: 11, a: 7 };
  const bytes = [];
  for (let i = 0; i < chars.length; i += 1) {
    if (chars[i] !== "\\") { bytes.push(...Buffer.from(chars[i], "utf8")); continue; }
    const next = chars[i + 1];
    if (next === undefined) { bytes.push(0x5c); break; }
    if (Object.hasOwn(escapes, next)) { bytes.push(escapes[next]); i += 1; continue; }
    const octal = chars.slice(i + 1, i + 4).join("").match(/^[0-7]{1,3}/);
    if (octal) { bytes.push(parseInt(octal[0], 8) & 0xff); i += octal[0].length; continue; }
    bytes.push(...Buffer.from(next, "utf8")); // \" -> ", \\ -> \, any other escaped char stays literal
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

// A `---`/`+++` header path. When an unquoted path contains a space, git
// terminates it with a tab (the header's path terminator); that tab is not
// part of the name. A name that really ends in a tab is always quoted, so
// only an unquoted value loses its trailing tab.
function headerPath(raw) {
  const value = raw.startsWith('"') ? raw : raw.replace(/\t$/, "");
  return value === "/dev/null" ? "/dev/null" : stripPathPrefix(value);
}

function stripPathPrefix(raw) {
  const value = unquoteGitPath(raw);
  if (value.startsWith("a/") || value.startsWith("b/")) return value.slice(2);
  return value;
}

// The two paths of a `diff --git` header. Git quotes either side when it holds
// a control character, a double quote, or a backslash, and a binary diff has
// no ---/+++ lines to restore the decoded path from, so the header must be
// read exactly: a quoted token runs to its closing quote (backslash escapes
// honoured). An unquoted pair is ambiguous when a name itself contains
// " b/", so the same-name form (the only one a binary diff cannot repair
// from later lines) is recognised by its symmetry — `a/P b/P` — before
// falling back to the last " b/" for a rename or copy, whose "rename from"
// and "rename to" lines then set both paths exactly.
function parseGitHeader(rest) {
  const closingQuote = (from) => {
    for (let i = from + 1; i < rest.length; i += 1) {
      if (rest[i] === "\\") i += 1;
      else if (rest[i] === '"') return i;
    }
    return -1;
  };
  let oldRaw;
  let newRaw;
  if (rest.startsWith('"')) {
    const end = closingQuote(0);
    if (end < 0) return ["", ""];
    oldRaw = rest.slice(0, end + 1);
    newRaw = rest.slice(end + 2);
  } else if (rest.includes(' "b/')) {
    const at = rest.indexOf(' "b/');
    oldRaw = rest.slice(0, at);
    newRaw = rest.slice(at + 1);
  } else {
    if (!rest.startsWith("a/")) return ["", ""];
    const body = rest.slice(2); // P b/P for a same-name diff
    const half = (body.length - 3) / 2;
    if (Number.isInteger(half) && half > 0 && body.slice(half, half + 3) === " b/" && body.slice(0, half) === body.slice(half + 3)) {
      const same = body.slice(0, half);
      return [same, same];
    }
    const match = rest.match(/^(a\/.*) (b\/.*)$/);
    if (!match) return ["", ""];
    [, oldRaw, newRaw] = match;
  }
  return [stripPathPrefix(oldRaw), stripPathPrefix(newRaw)];
}

function displayPath(file) {
  return file.newPath && file.newPath !== "/dev/null" ? file.newPath : file.oldPath;
}

export function parseUnifiedDiff(diffText) {
  const files = [];
  if (typeof diffText !== "string" || diffText.length === 0) return { files };

  const lines = diffText.split("\n");
  // The text's final newline splits into an empty last element. It is an
  // artifact of the split, not a line: left in, it would pass as a blank
  // context line and let a truncated hunk look whole by one line.
  if (lines.at(-1) === "") lines.pop();
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
      // A marker for a side the header has already spent is malformed
      // content: the counts would go negative and the review would carry
      // lines the header never declared.
      const side = marker === "-" ? "old" : marker === "+" ? "new" : (marker === " " || line === "") ? "both" : null;
      if ((side === "old" && remainingOld === 0) || (side === "new" && remainingNew === 0) || (side === "both" && (remainingOld === 0 || remainingNew === 0))) {
        throw new Error(`The diff is malformed: the hunk at -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} in ${file.path} has no ${side === "both" ? "old or new" : side} lines left when ${JSON.stringify(line.slice(0, 60))} arrived`);
      }
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
        // Not a diff line while the hunk still owes lines: the diff is
        // truncated or malformed. Reading on would swallow this line — a
        // `diff --git` header for the next file included — and present an
        // incomplete review as whole. Refused, naming what is owed.
        throw new Error(`The diff is truncated: the hunk at -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} in ${file.path} still owes ${remainingOld} old and ${remainingNew} new lines when ${JSON.stringify(line.slice(0, 60))} arrived`);
      }
      continue;
    }

    // A combined diff (`diff --cc`, `diff --combined`, `@@@` hunks) is what
    // git emits for a path with an unresolved merge conflict. Its files
    // start with no `diff --git` header, so reading past them would show a
    // review with those files missing — an apparently clean review of a
    // conflicted tree. Refused whole instead.
    if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
      throw new Error(`The diff holds an unresolved merge conflict (${line.slice(line.indexOf(" ", 5) + 1)}); resolve it before review`);
    }
    if (line.startsWith("diff --git ")) {
      startFile(...parseGitHeader(line.slice("diff --git ".length)));
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
      file.oldPath = headerPath(line.slice(4));
      if (file.newPath === "/dev/null" && file.status === "modified") file.status = "deleted";
      file.path = displayPath(file);
      continue;
    }
    if (line.startsWith("+++ ")) {
      file.newPath = headerPath(line.slice(4));
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
    // A content line after a hunk's counts are spent is more than the header
    // declared: the diff is malformed, and the extra lines would be dropped
    // from the review without a trace. Refused.
    if (/^[+\- ]/.test(line) && !line.startsWith("+++ ") && !line.startsWith("--- ")) {
      throw new Error(`The diff has content outside a hunk in ${file.path}: ${JSON.stringify(line.slice(0, 60))} exceeds the hunk header's counts`);
    }
    // Anything else after a hunk's counts are spent (the trailing empty split
    // element at EOF, index/mode lines) ends the hunk region without content.
    hunk = null;
  }
  // A diff that ends while a hunk still owes lines is truncated: what the
  // header promised never arrived, and the review would be of a fragment.
  if (hunk !== null && (remainingOld > 0 || remainingNew > 0)) {
    throw new Error(`The diff is truncated: the hunk at -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} in ${file.path} still owes ${remainingOld} old and ${remainingNew} new lines at the end of the diff`);
  }

  return { files };
}
