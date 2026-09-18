// Argument parsing for the obversa-review command, kept apart from the
// executable so tests import it without running the command and the
// executable itself needs no "am I main" guard (which broke symlinked bins).

export const HELP = `Open a git diff for inline review and return the annotations.

Usage:
  obversa-review                review the working tree
  obversa-review --staged       review the staged changes
  obversa-review --range A..B   review a ref range
  obversa-review --cwd <dir>    run against another repository
  obversa-review --no-open      print the surface URL instead of placing it
  obversa-review --app <name>   override the surface app name
`;

// The value that must follow a value-taking option. A missing value, or one
// shaped like another flag, is a usage error: a bare `--cwd` must never fall
// through to "review the current directory".
function valueFor(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${flag} needs a value${value === undefined ? "" : `, got ${value}`}`);
  }
  return value;
}

export function parseArgs(argv, { cwd = process.cwd() } = {}) {
  const options = { mode: "worktree", range: undefined, cwd, open: true, app: "review" };
  // The three modes are one choice: naming two is a usage error, not a
  // question of which came last.
  let chosen;
  const choose = (mode, flag) => {
    if (chosen && chosen.mode !== mode) throw new Error(`${flag} and ${chosen.flag} name different review modes; use one of --worktree, --staged, --range`);
    chosen = { mode, flag };
    options.mode = mode;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--staged" || arg === "--cached") choose("staged", arg);
    else if (arg === "--worktree") choose("worktree", arg);
    else if (arg === "--range") { choose("range", arg); options.range = valueFor(argv, index, arg); index += 1; }
    else if (arg === "--cwd") { options.cwd = valueFor(argv, index, arg); index += 1; }
    else if (arg === "--app") { options.app = valueFor(argv, index, arg); index += 1; }
    else if (arg === "--no-open") options.open = false;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.mode === "range" && !options.range) throw new Error("--range needs a ref range, for example main..HEAD");
  if (!/^[A-Za-z0-9._-]+$/.test(options.app)) throw new Error("--app must be letters, digits, '.', '_' or '-'");
  return options;
}
