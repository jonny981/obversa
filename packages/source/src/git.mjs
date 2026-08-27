import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

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
 */
export async function readNewFileText({ path: filePath, mode = "worktree", cwd = process.cwd() } = {}) {
  if (typeof filePath !== "string" || filePath.length === 0 || filePath === "/dev/null") return null;
  if (mode === "worktree") {
    try {
      return await readFile(join(cwd, filePath), "utf8");
    } catch {
      return null;
    }
  }
  if (mode === "staged") {
    try {
      // `:path` is the index blob; execFile passes it as one argv element and it
      // begins with ':', so a leading dash in the path can't read as an option.
      const { stdout } = await run("git", ["--no-pager", "show", `:${filePath}`], {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      });
      return stdout;
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
