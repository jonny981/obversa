import { execFile } from "node:child_process";
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
