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
// component refused if it is a symlink and the read bounded at MAX_FILE_BYTES.
async function readBoundedFile(target) {
  let handle;
  try {
    handle = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > MAX_FILE_BYTES) return null;
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
// otherwise yield empty paths and lose every anchor).
export function diffArgs({ mode = "worktree", range } = {}) {
  const base = [
    "-c", "diff.noprefix=false",
    "-c", "diff.mnemonicPrefix=false",
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
 * - staged: the index version, via `git show :path`.
 *
 * The path comes from the diff, and a diff can be supplied by a caller rather
 * than produced by git, so it is treated as untrusted. Both modes refuse an
 * absolute or climbing path. A worktree read refuses a symlink as the named
 * file itself — git's content for a symlink is its link text, so the target's
 * bytes would be false review content, wherever they live — then resolves
 * every directory on the way (realpath) and requires the real file to sit
 * inside the real repository root, so a symlinked directory that points
 * outside is refused too, and finally reads through one handle that refuses a
 * symlink again (O_NOFOLLOW) and stops at MAX_FILE_BYTES. A staged read
 * requires the index entry to be a regular file (a symlink entry would print
 * its link target, a tree cannot be shown) and bounds `git show`'s output the
 * same way. Anything refused yields null — the diff still renders, only the
 * expandable context is withheld.
 */
export async function readNewFileText({ path: filePath, mode = "worktree", cwd = process.cwd() } = {}) {
  if (typeof filePath !== "string" || filePath.length === 0 || filePath === "/dev/null") return null;
  if (!isSafeRelativePath(filePath)) return null;
  if (mode === "worktree") {
    let realRoot;
    let real;
    try {
      realRoot = await realpath(cwd);
      const named = resolve(realRoot, filePath);
      if ((await lstat(named)).isSymbolicLink()) return null;
      real = await realpath(named);
    } catch {
      return null;
    }
    if (!real.startsWith(realRoot + sep)) return null;
    return readBoundedFile(real);
  }
  if (mode === "staged") {
    try {
      // The index entry must be a regular file: mode 100644 or 100755. `--`
      // guards a leading dash; the pathspec is one argv element.
      const { stdout: entry } = await run("git", ["ls-files", "--stage", "--", filePath], { cwd, windowsHide: true });
      const indexMode = entry.split(/\s+/)[0];
      if (!/^100(?:644|755)$/.test(indexMode)) return null;
      // `:path` is the index blob. execFile's maxBuffer rejects output past the
      // bound, so an oversized blob fails here and yields null.
      const { stdout } = await run("git", ["--no-pager", "show", `:${filePath}`], {
        cwd,
        maxBuffer: MAX_FILE_BYTES + 1,
        windowsHide: true,
      });
      return Buffer.byteLength(stdout, "utf8") > MAX_FILE_BYTES ? null : stdout;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * List the repository's tracked files, for the tree's "All files" view. Returns
 * repo-relative paths (git's own order), or [] on any error.
 */
export async function listTrackedFiles({ cwd = process.cwd() } = {}) {
  try {
    const { stdout } = await run("git", ["-c", "core.quotePath=false", "ls-files"], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout.split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}
