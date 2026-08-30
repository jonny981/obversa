#!/usr/bin/env bash
# Deterministic proof for the host-owned placement binding. No UI opens and
# no real workspace is created: cmux is a recording shim, and the proof runs
# from a checkout path containing spaces against a temporary home. The live
# propagation half — cmux handing the variables to real terminal and agent
# children — is recorded by hand at gate time, as the live-client checks are.
set -u

HERE="$(cd "$(dirname "$0")" && pwd -P)"
BIN="$HERE/../bin"

SANDBOX="$(mktemp -d)" || { echo "f2b-placement-proof: mktemp -d failed; not running" >&2; exit 1; }
[ -n "$SANDBOX" ] && [ -d "$SANDBOX" ] || { echo "f2b-placement-proof: sandbox invalid" >&2; exit 1; }
trap 'rm -rf "$SANDBOX"' EXIT

# Nothing under the real home is read or written: the proof pins HOME.
export HOME="$SANDBOX/home"
mkdir -p "$HOME"

PASS=0
FAIL=0
check() {
  if [ "$1" -eq 0 ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL: $2" >&2; fi
}

# The cmux shim records each call's argv one argument per line, calls
# separated by a blank line, so quoting survives for the assertions.
SHIMS="$SANDBOX/shims"
mkdir -p "$SHIMS"
cat >"$SHIMS/cmux" <<EOF
#!/bin/sh
printf '%s\n' "\$@" >> "$SANDBOX/calls-cmux"
printf '\n' >> "$SANDBOX/calls-cmux"
exit 0
EOF
chmod +x "$SHIMS/cmux"
PATH="$SHIMS:/usr/bin:/bin"
export PATH

# The launcher runs from a checkout path containing spaces: the host bin
# directory is copied whole, so HERE resolves inside the spaced path.
SPACED="$SANDBOX/checkout with spaces/bin"
mkdir -p "$SPACED"
cp "$BIN"/obversa-cmux-workspace "$BIN"/obversa-surface "$BIN"/obversa-plannotator-browser "$SPACED/"
# The launcher resolves its directory by real path (pwd -P), so the
# expectation does too: on macOS the temp root is itself a symlink.
SPACED="$(cd "$SPACED" && pwd -P)"
REPO_DIR="$SANDBOX/repo dir"
mkdir -p "$REPO_DIR"

"$SPACED/obversa-cmux-workspace" "$REPO_DIR" >/dev/null 2>&1
check $? "the launcher exits 0 with a directory argument"
# Captured before the python assertion helpers run: python itself writes its
# cache under ~/Library on macOS, and only the launcher is under proof here.
HOME_AFTER_LAUNCH="$(ls -A "$HOME")"

# One cmux call, argv exact: create, the spaced cwd, and both --env values
# each one argument carrying the spaced absolute path.
python3 - "$SANDBOX/calls-cmux" "$SPACED" "$REPO_DIR" <<'PYEOF'
import sys
calls_file, spaced, repo = sys.argv[1:4]
calls = [c.split("\n") for c in open(calls_file).read().strip().split("\n\n")]
assert len(calls) == 1, f"expected one cmux call, saw {len(calls)}"
argv = calls[0]
expected = [
    "workspace", "create", "--cwd", repo,
    "--env", f"OBVERSA_SURFACE_BIN={spaced}/obversa-surface",
    "--env", f"PLANNOTATOR_BROWSER={spaced}/obversa-plannotator-browser",
]
assert argv == expected, f"argv mismatch:\n  got      {argv}\n  expected {expected}"
PYEOF
check $? "cmux receives create with --cwd and both --env values as exact quoted argv"

python3 - "$SANDBOX/calls-cmux" <<'PYEOF'
import sys
argv = open(sys.argv[1]).read()
assert " " in argv.split("OBVERSA_SURFACE_BIN=")[1].split("\n")[0], "the spaced path survived as one value"
PYEOF
check $? "a checkout path containing spaces stays one argument"

# Usage errors: help exits 0, no argument and a non-directory exit 2, and
# none of them reaches cmux.
rm -f "$SANDBOX/calls-cmux"
"$SPACED/obversa-cmux-workspace" --help >/dev/null 2>&1
check $? "--help exits 0"
"$SPACED/obversa-cmux-workspace" >/dev/null 2>&1
[ $? -eq 2 ]; check $? "no argument exits 2"
"$SPACED/obversa-cmux-workspace" "$SANDBOX/not-there" >/dev/null 2>&1
[ $? -eq 2 ]; check $? "a missing directory exits 2"
[ ! -f "$SANDBOX/calls-cmux" ]; check $? "a usage error never reaches cmux"

# The temporary home stayed as this proof made it: the launcher writes no
# profile, no settings file, nothing under home.
[ -z "$HOME_AFTER_LAUNCH" ]; check $? "nothing was written under the home directory (found: $HOME_AFTER_LAUNCH)"

echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
