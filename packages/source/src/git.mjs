import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

// Upper bound on one file read for full-file context. It bounds both the read
// and the highlighter's parse of that text; a larger file gets no expandable
// context (the diff hunks still render).
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

// A diff path is only ever read when it is relative and never climbs. Git's
// own diffs satisfy this; the check exists for diff text supplied by a caller.
function isSafeRelativePath(filePath) {
  if (filePath.includes("\0") || isAbsolute(filePath) || /^[\\/]/.test(filePath)) return false;
  return filePath.split(/[\\/]+/).every((segment) => segment !== "..");
}

// Read one regular file through a single handle, so the file that is checked
// is the file that is read (no stat-then-read window), with the final
// component refused if it is a symlink and the read bounded at `limit` bytes.
// `identity` is the device and inode the caller checked before resolving the
// path: O_NOFOLLOW guards the final component only, so a parent swapped for a
// symlink between that check and this open would open another file — one
// whose identity differs, and which is then refused.
// The open the reader uses, as a port so a test can make an open land on a
// file other than the one checked, the way a swapped parent would.
export const readerPorts = { open };
export async function readBoundedFile(target, limit = MAX_FILE_BYTES, identity) {
  let handle;
  try {
    handle = await readerPorts.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) return null;
    if (identity && (info.dev !== identity.dev || info.ino !== identity.ino)) return null;
    const buffer = Buffer.alloc(limit + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > limit) return null;
    return buffer.subarray(0, filled).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

// A ref range is one revision token: a single ref, `A..B`, or `A...B`. It is
// passed to git as one argv element (no shell is involved), so the only real
// hazard is a leading dash that git would read as an option. Reject that, an
// empty range, and control characters or whitespace that never belong in a
// revision. Everything else git validates itself and reports cleanly.
function assertSafeRange(range) {
  if (typeof range !== "string" || range.length === 0) {
    throw new TypeError("A ref range is required in range mode");
  }
  if (range.startsWith("-")) {
    throw new Error(`A ref range must not start with '-': ${range}`);
  }
  if (/\s/.test(range) || [...range].some((c) => c.charCodeAt(0) < 0x20)) {
    throw new Error(`A ref range must not contain whitespace or control characters: ${range}`);
  }
}

// Build the git argument list for one review mode. The flags keep the output a
// plain unified diff regardless of the reviewed repository's git config, which
// is what the parser expects: `--no-pager`/`--no-color` for plain text,
// `--no-ext-diff`/`--no-textconv` so a repo's diff driver or textconv filter
// cannot substitute arbitrary program output for the real hunks, and the two
// prefix settings so the `a/` and `b/` path prefixes the parser keys on are
// always present (a repo with diff.noprefix or diff.mnemonicPrefix would
// otherwise yield empty paths and lose every anchor), and
// `diff.suppressBlankEmpty=false` so a blank context line is always emitted as
// a single space (with it on, a blank context line is an empty line, which
// once ended the hunk early and hid every later changed line).
export function diffArgs({ mode = "worktree", range } = {}) {
  const base = [
    "-c", "diff.noprefix=false",
    "-c", "diff.mnemonicPrefix=false",
    "-c", "diff.suppressBlankEmpty=false",
    "-c", "core.quotePath=false",
    "--no-pager", "diff", "--no-color", "--no-ext-diff", "--no-textconv",
  ];
  if (mode === "worktree") return base;
  if (mode === "staged") return [...base, "--cached"];
  if (mode === "range") {
    assertSafeRange(range);
    // `--` after the range guarantees git treats the token as a revision and
    // never as a pathspec, even for an unusual but valid ref name.
    return [...base, range, "--"];
  }
  throw new Error(`Unknown diff mode: ${mode}`);
}

/**
 * The repository's top-level directory for `cwd`, or null outside a repository.
 * Git prints diff paths relative to this root wherever the command runs, so
 * every read that resolves a diff path must resolve it against the root, not
 * against the directory the command happened to start in.
 */
export async function repositoryRoot({ cwd = process.cwd() } = {}) {
  try {
    const { stdout } = await run("git", ["rev-parse", "--show-toplevel"], { cwd, windowsHide: true });
    const root = stdout.trim();
    return root.length > 0 ? root : null;
  } catch {
    return null;
  }
}

/**
 * Run git and return the unified diff text for one of three review modes:
 * the working tree (`git diff`), the staged changes (`git diff --cached`), or
 * a ref range (`git diff <range>`). The caller parses the text with
 * parseUnifiedDiff.
 */
export async function computeDiff({ mode = "worktree", range, cwd = process.cwd() } = {}) {
  const args = diffArgs({ mode, range });
  const { stdout } = await run("git", args, {
    cwd,
    // Diffs can be large; allow room but stay bounded.
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return { diffText: stdout, mode, range: mode === "range" ? range : null };
}

/**
 * Read the full NEW-side content of a file under review, so a full-file parser
 * (go-to-source) can see code the diff hunks alone do not contain. Returns the
 * text, or null when it is unavailable — a deleted path, an unreadable file, or
 * range mode (a range's new side is not a single readable object in v1).
 * - worktree: the working-tree file on disk.
 * - staged: the index version, read as the blob the index names for the path.
 *
 * The path comes from the diff, and a diff can be supplied by a caller rather
 * than produced by git, so it is treated as untrusted. Both modes refuse an
 * absolute or climbing path. A worktree read refuses a symlink as the named
 * file itself — git's content for a symlink is its link text, so the target's
 * bytes would be false review content, wherever they live — then resolves
 * every directory on the way (realpath) and requires the real file to sit
 * inside the real repository root, so a symlinked directory that points
 * outside is refused too, and finally reads through one handle that refuses a
 * symlink again (O_NOFOLLOW) and stops at the byte limit. A staged read
 * requires the index to hold exactly this path at stage 0 as a regular file
 * (a symlink entry would print its link target, a tree cannot be shown) and
 * reads the blob by its hash, bounded the same way. Anything refused yields
 * null — the diff still renders, only the expandable context is withheld.
 *
 * `maxBytes` lowers the limit for one read (never above MAX_FILE_BYTES), so a
 * caller holding a budget across many reads can bound the sum exactly.
 * @param {{ path?: string, mode?: string, cwd?: string, maxBytes?: number }} [options]
 * @returns {Promise<string | null>}
 */
export async function readNewFileText({ path: filePath, mode = "worktree", cwd = process.cwd(), maxBytes = MAX_FILE_BYTES } = {}) {
  if (typeof filePath !== "string" || filePath.length === 0 || filePath === "/dev/null") return null;
  if (!isSafeRelativePath(filePath)) return null;
  const limit = Number.isFinite(maxBytes) && maxBytes < MAX_FILE_BYTES ? Math.max(0, Math.floor(maxBytes)) : MAX_FILE_BYTES;
  if (mode === "worktree") {
    let realRoot;
    let real;
    let checked;
    try {
      realRoot = await realpath(cwd);
      const named = resolve(realRoot, filePath);
      checked = await lstat(named);
      if (checked.isSymbolicLink()) return null;
      real = await realpath(named);
    } catch {
      return null;
    }
    if (!real.startsWith(realRoot + sep)) return null;
    // The handle that is read must be the file that was checked: same
    // device, same inode. A parent component swapped for a symlink after
    // the check opens a different file, and that read is refused.
    return readBoundedFile(real, limit, { dev: checked.dev, ino: checked.ino });
  }
  if (mode === "staged") {
    try {
      // The index entry must be exactly this path, at stage 0, as a regular
      // file (mode 100644 or 100755). `--literal-pathspecs` stops git reading
      // the path as a glob or as pathspec magic, `-z` stops it quoting an
      // unusual name, and `--` guards a leading dash.
      const { stdout: listing } = await run("git", ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", filePath], { cwd, windowsHide: true });
      const entry = listing.split("\0").map((line) => {
        const tab = line.indexOf("\t");
        const [entryMode, hash, stage] = line.slice(0, tab).split(" ");
        return { entryMode, hash, stage, entryPath: line.slice(tab + 1) };
      }).find((candidate) => candidate.entryPath === filePath && candidate.stage === "0");
      if (!entry || !/^100(?:644|755)$/.test(entry.entryMode) || !/^[0-9a-f]{40,64}$/.test(entry.hash)) return null;
      // Read the blob by the hash the index just gave for this exact path.
      // `git show :<path>` would read a colon inside the path as stage syntax
      // (`:0:secret.js` is stage 0 of secret.js), so a repository holding both
      // `secret.js` and `0:secret.js` would show the wrong file. execFile's
      // maxBuffer rejects output past the bound, so an oversized blob fails
      // here and yields null.
      const { stdout } = await run("git", ["--no-pager", "cat-file", "blob", entry.hash], {
        cwd,
        maxBuffer: limit + 1,
        windowsHide: true,
      });
      return Buffer.byteLength(stdout, "utf8") > limit ? null : stdout;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The tracked files of one repository state, for the tree's "All files" view:
 * the index by default, or the tree of one commit when `ref` is given.
 * Returns repository-relative paths (git's own order) whatever directory
 * `cwd` is, so they match the diff's paths; [] on any error.
 * @param {{ cwd?: string, ref?: string }} [options]
 * @returns {Promise<string[]>}
 */
export async function listTrackedFiles({ cwd = process.cwd(), ref } = {}) {
  // The index (what the worktree and staged reviews are against), or the
  // tree of one commit (what a range review ends at) — never one for the
  // other, so the list belongs to the state the diff describes.
  // -z: each name ends in NUL and is written raw. Without it git quotes a
  // name holding a backslash, a tab, a quote, or a control character (and
  // a newline would split one name into several), so the names could not
  // match the diff's decoded paths.
  const args = ref === undefined
    ? ["ls-files", "-z", "--full-name", "--", ":/"]
    : ["ls-tree", "-r", "-z", "--name-only", "--full-tree", ref, "--"];
  try {
    const { stdout } = await run("git", args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout.split("\0").filter((name) => name.length > 0);
  } catch {
    return [];
  }
}

/**
 * The revision a range review ends at, asked of git rather than parsed: a
 * revision's own text can hold two dots (`:/fix..bug` and `HEAD^{/fix..bug}`
 * are single commits), so no regex over the token is right. `git rev-parse
 * --revs-only` expands a real range into positive revisions plus at least
 * one `^`-excluded one (`A..B` → B ^A; `A...B` → B A ^merge-base; an omitted
 * right side stands for HEAD), and a single object into one line with no
 * exclusion. A range ends at its first positive revision — the right side in
 * both forms — returned as the exact object id. Exactly one positive line
 * and no exclusion is a single revision: it diffs against the worktree and
 * ends there (undefined). Several positive lines with no exclusion is a
 * revision set that is not a range (`HEAD^@`, a merge's parents, which git
 * diffs against each other): the review does not support it and refuses it
 * before opening, rather than guessing an end. No positive line, or a token
 * git cannot resolve, is an error, never a silent fall-through to the index.
 * @param {{ cwd?: string, range: string }} options
 * @returns {Promise<string | undefined>}
 */
export async function rangeEnd({ cwd = process.cwd(), range }) {
  assertSafeRange(range);
  let stdout;
  try {
    ({ stdout } = await run("git", ["rev-parse", "--revs-only", range, "--"], { cwd, windowsHide: true }));
  } catch (error) {
    throw new Error(`The range could not be resolved: ${range} (${error?.stderr?.trim?.() || error?.message || error})`);
  }
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  const positives = lines.filter((line) => !line.startsWith("^"));
  if (positives.length === 0) throw new Error(`The range names no revision: ${range}`);
  if (positives.length === lines.length) {
    if (positives.length === 1) return undefined;
    throw new Error(`The range is a revision set the review does not support: ${range}`);
  }
  return positives[0];
}
