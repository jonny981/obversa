#!/usr/bin/env bash
# Deterministic proof for the F0 host glue. No UI opens. External commands
# (cmux, open, code) are replaced with recording shims on PATH.
set -u

HERE="$(cd "$(dirname "$0")" && pwd -P)"
BIN="$HERE/../bin"
REPO="$(cd "$HERE/../../.." && pwd -P)"

# Refuse to run without a real sandbox: with an empty SANDBOX every later
# path would resolve relative to the filesystem root.
SANDBOX="$(mktemp -d)" || { echo "f0-proof: mktemp -d failed; no sandbox, not running" >&2; exit 1; }
[ -n "$SANDBOX" ] && [ -d "$SANDBOX" ] || { echo "f0-proof: sandbox path invalid: '$SANDBOX'" >&2; exit 1; }
trap 'rm -rf "$SANDBOX"' EXIT

# --- recording shims -------------------------------------------------------
SHIMS="$SANDBOX/shims"
mkdir -p "$SHIMS"
for tool in open code; do
  cat >"$SHIMS/$tool" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$SANDBOX/calls-$tool"
EOF
  chmod +x "$SHIMS/$tool"
done
# The cmux shim also answers `tree` from a canned file when present, and
# fails `new-pane` when the cmux-fail flag file exists.
cat >"$SHIMS/cmux" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$SANDBOX/calls-cmux"
case "\$1" in
  tree)
    if [ -f "$SANDBOX/tree-hang" ]; then trap '' TERM; sleep 60; exit 1; fi
    if [ -f "$SANDBOX/tree-fail" ]; then exit 1; fi
    if [ -f "$SANDBOX/tree.json" ]; then cat "$SANDBOX/tree.json"; fi ;;
  new-pane) if [ -f "$SANDBOX/cmux-fail" ]; then exit 1; fi ;;
esac
exit 0
EOF
chmod +x "$SHIMS/cmux"
# Shims first, then the standard system directories, then the directories
# that hold the real python3, git, and shasum on this machine. A machine
# whose tools come from Homebrew instead of /usr/bin still proves.
PATH="$SHIMS:/usr/bin:/bin"
for t in python3 git shasum; do
  d="$(dirname "$(command -v "$t" 2>/dev/null || echo /usr/bin/x)")"
  case ":$PATH:" in *":$d:"*) ;; *) PATH="$PATH:$d" ;; esac
done
export PATH
# The glue resolves every command it runs from fixed system directories;
# the proof puts its shims first on that list (cmux, open, code are
# shimmed) and keeps the system python3 behind them.
export OBVERSA_SYSTEM_BIN_DIRS="$SHIMS:/usr/bin:/bin"
export XDG_STATE_HOME="$SANDBOX/state"
unset OBVERSA_SHARED_ROOT OBVERSA_EDITOR_CMD 2>/dev/null
unset CMUX_WORKSPACE_ID CMUX_SURFACE_ID CMUX_TAB_ID CMUX_PANEL_ID 2>/dev/null

mkdir -p "$SANDBOX/roots/project" "$SANDBOX/roots/shared"
# Compare against physical paths: on macOS, mktemp yields /var/..., which is
# a symlink to /private/var/..., and the generator stores physical paths.
PROJ="$(cd "$SANDBOX/roots/project" && pwd -P)"
SHRD="$(cd "$SANDBOX/roots/shared" && pwd -P)"

PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "ok  - $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL - $1"; }
check() { if [ "$1" -eq 0 ]; then ok "$2"; else bad "$2"; fi; }

# --- generator: happy path -------------------------------------------------
OUT="$("$BIN/obversa-order-workspace" --project "$PROJ" --shared "$SHRD" \
  --name order-a --no-open --print-path 2>"$SANDBOX/err")"
RC=$?
check $RC "generator exits zero on peer roots"
[ "$OUT" = "$XDG_STATE_HOME/obversa/workspaces/order-a.code-workspace" ]
check $? "generator prints the workspace file path"
[ -f "$OUT" ]
check $? "generator writes the workspace file"

FILE="$OUT" PROJ="$PROJ" SHRD="$SHRD" python3 - <<'PY'
import json, os, sys
doc = json.load(open(os.environ["FILE"]))
folders = doc["folders"]
assert len(folders) == 2, "two roots"
assert folders[0]["path"] == os.environ["PROJ"], "project root path"
assert folders[1]["path"] == os.environ["SHRD"], "shared root path"
assert folders[0]["name"].startswith("Project"), "project root name"
assert folders[1]["name"].startswith("Shared"), "shared root name"
for f in folders:
    assert not folders[0]["path"].startswith(folders[1]["path"] + "/"), "peers"
    assert not folders[1]["path"].startswith(folders[0]["path"] + "/"), "peers"
sys.exit(0)
PY
check $? "workspace file holds the two peer roots in order"

# --- generator: default name ----------------------------------------------
DEFAULT_PATH="$("$BIN/obversa-order-workspace" --project "$PROJ" --shared "$SHRD" \
  --no-open --print-path)"
basename "$DEFAULT_PATH" | grep -Eq '^project-[0-9a-f]{64}\.code-workspace$' && [ -f "$DEFAULT_PATH" ]
check $? "generator names the file after the Project basename plus the full pair hash"

# --- generator: paths with newlines cannot alias another pair ---------------
# The pair serialization joins on NUL, so a directory whose name contains a
# newline hashes differently from its newline-free lookalike.
mkdir -p "$SANDBOX/amb/plain" "$SANDBOX/amb/"$'nl\nname' "$SANDBOX/amb/other"
NL_PATH="$("$BIN/obversa-order-workspace" --project "$SANDBOX/amb/"$'nl\nname' \
  --shared "$SANDBOX/amb/other" --no-open --print-path)"
PLAIN_PATH="$("$BIN/obversa-order-workspace" --project "$SANDBOX/amb/plain" \
  --shared "$SANDBOX/amb/other" --no-open --print-path)"
[ -n "$NL_PATH" ] && [ -f "$NL_PATH" ] && [ "$NL_PATH" != "$PLAIN_PATH" ]
check $? "a newline in a root path still produces its own valid binding file"

# --- generator: a basename with no allowed characters still gets a name -----
mkdir -p "$SANDBOX/unicode/日本語"
UNI_PATH="$("$BIN/obversa-order-workspace" --project "$SANDBOX/unicode/日本語" \
  --shared "$SHRD" --no-open --print-path)"
basename "$UNI_PATH" | grep -Eq '^w[-A-Za-z0-9._]*-[0-9a-f]{64}\.code-workspace$' && [ -f "$UNI_PATH" ]
check $? "an all-sanitized basename gains a prefix instead of failing validation"

# --- generator: a very long basename stays under the filesystem limit -------
LONGBASE="$(printf 'x%.0s' $(seq 1 200))"
mkdir -p "$SANDBOX/long/$LONGBASE"
LONG_PATH="$("$BIN/obversa-order-workspace" --project "$SANDBOX/long/$LONGBASE" \
  --shared "$SHRD" --no-open --print-path)"
[ -f "$LONG_PATH" ] && [ "$(basename "$LONG_PATH" | wc -c)" -le 255 ]
check $? "a 200-byte Project basename still produces a creatable file name"

# --- generator: rejects non-peer roots -------------------------------------
mkdir -p "$PROJ/nested"
"$BIN/obversa-order-workspace" --project "$PROJ" --shared "$PROJ/nested" --no-open >/dev/null 2>&1
[ $? -ne 0 ]
check $? "generator rejects a Shared root inside the Project root"

"$BIN/obversa-order-workspace" --project "$PROJ/nested" --shared "$PROJ" --no-open >/dev/null 2>&1
[ $? -ne 0 ]
check $? "generator rejects a Project root inside the Shared root"

"$BIN/obversa-order-workspace" --project "$PROJ" --shared "$PROJ" --no-open >/dev/null 2>&1
[ $? -ne 0 ]
check $? "generator rejects identical roots"

# --- generator: missing shared root ----------------------------------------
"$BIN/obversa-order-workspace" --project "$PROJ" --no-open >"$SANDBOX/out" 2>"$SANDBOX/err"
RC=$?
[ $RC -ne 0 ] && grep -q "OBVERSA_SHARED_ROOT" "$SANDBOX/err"
check $? "generator fails with guidance when no Shared root is given"

# --- generator: env default ------------------------------------------------
OBVERSA_SHARED_ROOT="$SHRD" "$BIN/obversa-order-workspace" --project "$PROJ" \
  --name from-env --no-open >/dev/null 2>&1
check $? "generator accepts OBVERSA_SHARED_ROOT as the Shared default"

# --- generator: one binding per Order --------------------------------------
mkdir -p "$SANDBOX/orders/a/project" "$SANDBOX/orders/b/project"
NAME_A="$("$BIN/obversa-order-workspace" --project "$SANDBOX/orders/a/project" \
  --shared "$SHRD" --no-open --print-path)"
NAME_B="$("$BIN/obversa-order-workspace" --project "$SANDBOX/orders/b/project" \
  --shared "$SHRD" --no-open --print-path)"
NAME_A2="$("$BIN/obversa-order-workspace" --project "$SANDBOX/orders/a/project" \
  --shared "$SHRD" --no-open --print-path)"
[ "$NAME_A" != "$NAME_B" ] && [ "$NAME_A" = "$NAME_A2" ]
check $? "default names differ per root pair and stay stable for one pair"

# --- generator: name validation --------------------------------------------
"$BIN/obversa-order-workspace" --project "$PROJ" --shared "$SHRD" \
  --name '../escape' --no-open >/dev/null 2>&1
[ $? -ne 0 ]
check $? "generator rejects a name with a parent-directory segment"

"$BIN/obversa-order-workspace" --project "$PROJ" --shared "$SHRD" \
  --name 'a/b' --no-open >/dev/null 2>&1
[ $? -ne 0 ]
check $? "generator rejects a name with a path separator"

"$BIN/obversa-order-workspace" --project "$PROJ" --shared "$SHRD" \
  --name 'v1..2' --no-open >/dev/null 2>&1
check $? "generator accepts a harmless name that contains two dots"

"$BIN/obversa-order-workspace" --project "$PROJ" --shared "$SHRD" \
  --name "$(printf 'a\nb')" --no-open >/dev/null 2>&1
[ $? -ne 0 ]
check $? "generator rejects a name with a control character"

"$BIN/obversa-order-workspace" --project "$PROJ" --shared "$SHRD" \
  --name --no-open >/dev/null 2>&1
[ $? -ne 0 ]
check $? "generator rejects a flag-shaped value swallowed by --name"

LONGNAME="$(printf 'n%.0s' $(seq 1 240))"
"$BIN/obversa-order-workspace" --project "$PROJ" --shared "$SHRD" \
  --name "$LONGNAME" --no-open >/dev/null 2>&1
[ $? -ne 0 ]
check $? "generator rejects an explicit name over 200 characters"

for FLAG in --project --shared --name; do
  "$BIN/obversa-order-workspace" "$FLAG" >"$SANDBOX/out" 2>"$SANDBOX/err"
  RC=$?
  [ $RC -eq 2 ] && grep -q "Usage" "$SANDBOX/err" || { FLAGFAIL=1; break; }
done
[ "${FLAGFAIL:-0}" -eq 0 ]
check $? "generator prints usage and exits 2 for every missing option value"

"$BIN/obversa-order-workspace" --project --shared >"$SANDBOX/out" 2>"$SANDBOX/err"
RC=$?
[ $RC -eq 2 ] && grep -q "Usage" "$SANDBOX/err"
check $? "generator refuses to swallow a following option as a value"

"$BIN/obversa-order-workspace" --project "$PROJ" --shared "$SHRD" \
  --name --no-open >"$SANDBOX/out" 2>"$SANDBOX/err"
RC=$?
[ $RC -eq 2 ] && grep -q "Usage" "$SANDBOX/err"
check $? "a flag after --name is a missing value with usage, not a name"

# --- generator: a directory squatting on the target path fails cleanly ------
mkdir -p "$XDG_STATE_HOME/obversa/workspaces/squat.code-workspace"
"$BIN/obversa-order-workspace" --project "$PROJ" --shared "$SHRD" \
  --name squat --no-open >"$SANDBOX/out" 2>"$SANDBOX/err"
RC=$?
[ $RC -ne 0 ] && grep -q "directory" "$SANDBOX/err"
check $? "generator refuses a target path that is a directory"

# --- generator: a symlink on the target path cannot truncate its victim -----
printf 'precious\n' >"$SANDBOX/victim.txt"
mkdir -p "$XDG_STATE_HOME/obversa/workspaces"
ln -sf "$SANDBOX/victim.txt" "$XDG_STATE_HOME/obversa/workspaces/lnk.code-workspace"
"$BIN/obversa-order-workspace" --project "$PROJ" --shared "$SHRD" \
  --name lnk --no-open >/dev/null 2>&1
grep -q "precious" "$SANDBOX/victim.txt" && \
  [ ! -L "$XDG_STATE_HOME/obversa/workspaces/lnk.code-workspace" ] && \
  grep -q '"folders"' "$XDG_STATE_HOME/obversa/workspaces/lnk.code-workspace"
check $? "a symlink on the target path is replaced, its victim untouched"

# --- generator: a trailing newline in a root name survives into the binding --
mkdir -p "$SANDBOX/nl2/"$'proj\n'
NL2_PATH="$("$BIN/obversa-order-workspace" --project "$SANDBOX/nl2/"$'proj\n' \
  --shared "$SHRD" --no-open --print-path)"
FILE="$NL2_PATH" python3 - <<'PY'
import json, os, sys
doc = json.load(open(os.environ["FILE"]))
sys.exit(0 if doc["folders"][0]["path"].endswith("\n") else 1)
PY
check $? "a root path that ends in a newline is stored exactly, not stripped"

# --- generator: the filesystem root cannot slip past the peer guard ---------
"$BIN/obversa-order-workspace" --project / --shared "$SHRD" --no-open >/dev/null 2>&1
[ $? -ne 0 ]
check $? "generator rejects the filesystem root as a Project root containing the Shared root"

# --- generator: --help works without python3 --------------------------------
mkdir -p "$SANDBOX/catonly"
ln -sf /bin/cat "$SANDBOX/catonly/cat"
PATH="$SANDBOX/catonly" /bin/bash "$BIN/obversa-order-workspace" --help >/dev/null 2>&1
check $? "generator --help works on a machine without python3"

# --- generator: opens the editor -------------------------------------------
: >"$SANDBOX/calls-code" 2>/dev/null || true
"$BIN/obversa-order-workspace" --project "$PROJ" --shared "$SHRD" --name open-me >/dev/null 2>&1
grep -q "open-me.code-workspace" "$SANDBOX/calls-code" 2>/dev/null
check $? "generator opens the workspace file with the editor command"

# --- surface: inside cmux --------------------------------------------------
: >"$SANDBOX/calls-cmux"
CMUX_WORKSPACE_ID="w-test" "$BIN/obversa-surface" "http://localhost:9999/x" >/dev/null 2>&1
grep -q -- "new-pane --type browser --direction right --workspace w-test --url http://localhost:9999/x" \
  "$SANDBOX/calls-cmux"
check $? "surface opens a browser pane in the caller's cmux workspace"

# --- surface: live topology beats the frozen environment -------------------
# The canned tree mirrors the real `cmux tree --all --json --id-format both`
# shape and places the caller's surface in W-LIVE while the frozen
# environment still says w-stale — the moved-terminal case. The first
# workspace holds a decoy surface whose title contains the caller UUID;
# titles are data and must never select the workspace.
cat >"$SANDBOX/tree.json" <<'EOF'
{
  "caller": {"workspace_ref": "workspace:2"},
  "windows": [
    {
      "ref": "window:1",
      "workspaces": [
        {
          "ref": "workspace:2", "id": "W-STALE-0000-0000-0000-000000000000",
          "panes": [
            {"ref": "pane:1", "surfaces": [
              {"ref": "surface:1", "id": "S1110000-0000-0000-0000-000000000000",
               "type": "terminal", "title": "echo SURF-CALLER-0000-0000-000000000000"}
            ]}
          ]
        },
        {
          "ref": "workspace:7", "id": "W-LIVE-0000-0000-0000-0000-0000000000",
          "panes": [
            {"ref": "pane:9", "surfaces": [
              {"ref": "surface:9", "id": "SURF-CALLER-0000-0000-000000000000",
               "type": "terminal", "title": "caller"}
            ]}
          ]
        }
      ]
    }
  ]
}
EOF
: >"$SANDBOX/calls-cmux"
CMUX_SURFACE_ID="SURF-CALLER-0000-0000-000000000000" CMUX_WORKSPACE_ID="w-stale" \
  "$BIN/obversa-surface" "http://localhost:9999/x" >/dev/null 2>&1
grep -q -- "--workspace W-LIVE-0000-0000-0000-0000-0000000000" "$SANDBOX/calls-cmux"
check $? "surface takes the caller's workspace from the live tree, not the frozen env"

# --- surface: hostile JSON without topology opens the default browser -------
printf '{"error": "permission denied"}\n' >"$SANDBOX/tree.json"
: >"$SANDBOX/calls-cmux"
: >"$SANDBOX/calls-open"
CMUX_SURFACE_ID="SURF-CALLER-0000-0000-000000000000" CMUX_WORKSPACE_ID="w-stale" \
  "$BIN/obversa-surface" "http://localhost:9999/e" >/dev/null 2>&1
grep -q "http://localhost:9999/e" "$SANDBOX/calls-open" && \
  ! grep -q -- "new-pane" "$SANDBOX/calls-cmux"
check $? "surface treats JSON without a windows list as failure, never the stale workspace"
rm -f "$SANDBOX/tree.json"

# --- surface: python parse failure opens the default browser ----------------
mkdir -p "$SANDBOX/brokepy"
printf '#!/bin/sh\nexit 127\n' >"$SANDBOX/brokepy/python3"
chmod +x "$SANDBOX/brokepy/python3"
: >"$SANDBOX/calls-cmux"
: >"$SANDBOX/calls-open"
PATH="$SANDBOX/brokepy:$PATH" CMUX_SURFACE_ID="SURF-CALLER-0000-0000-000000000000" \
  CMUX_WORKSPACE_ID="w-stale" "$BIN/obversa-surface" "http://localhost:9999/p" >/dev/null 2>&1
grep -q "http://localhost:9999/p" "$SANDBOX/calls-open" && \
  ! grep -q -- "new-pane" "$SANDBOX/calls-cmux"
check $? "surface opens the default browser when the parse fails, never the stale workspace"
rm -f "$SANDBOX/tree.json"

# --- surface: with a surface id, the tree is the only authority --------------
# A healthy tree without the caller's surface, an empty topology, and a
# workspace with no usable id must all open the default browser. The frozen
# environment is never consulted when a surface id exists.
cat >"$SANDBOX/tree.json" <<'EOF'
{"windows": [{"ref": "window:1", "workspaces": [
  {"ref": "workspace:2", "id": "W-OTHER-0000-0000-0000-000000000000",
   "panes": [{"ref": "pane:1", "surfaces": [
     {"ref": "surface:1", "id": "S1110000-0000-0000-0000-000000000000", "title": "other"}]}]}
]}]}
EOF
: >"$SANDBOX/calls-cmux"
: >"$SANDBOX/calls-open"
CMUX_SURFACE_ID="NOT-IN-ANY-TREE" CMUX_WORKSPACE_ID="w-env" \
  "$BIN/obversa-surface" "http://localhost:9999/x" >/dev/null 2>&1
grep -q "http://localhost:9999/x" "$SANDBOX/calls-open" && \
  ! grep -q -- "new-pane" "$SANDBOX/calls-cmux"
check $? "surface opens the default browser when the tree lacks the caller's surface"

printf '{"windows": []}\n' >"$SANDBOX/tree.json"
: >"$SANDBOX/calls-cmux"
: >"$SANDBOX/calls-open"
CMUX_SURFACE_ID="SURF-CALLER-0000-0000-000000000000" CMUX_WORKSPACE_ID="w-stale" \
  "$BIN/obversa-surface" "http://localhost:9999/w" >/dev/null 2>&1
grep -q "http://localhost:9999/w" "$SANDBOX/calls-open" && \
  ! grep -q -- "new-pane" "$SANDBOX/calls-cmux"
check $? "surface treats an empty topology as no answer, never the stale workspace"

cat >"$SANDBOX/tree.json" <<'EOF'
{"windows": [{"ref": "window:1", "workspaces": [
  {"panes": [{"ref": "pane:1", "surfaces": [
     {"ref": "surface:9", "id": "SURF-CALLER-0000-0000-000000000000", "title": "caller"}]}]}
]}]}
EOF
: >"$SANDBOX/calls-cmux"
: >"$SANDBOX/calls-open"
CMUX_SURFACE_ID="SURF-CALLER-0000-0000-000000000000" CMUX_WORKSPACE_ID="w-stale" \
  "$BIN/obversa-surface" "http://localhost:9999/n" >/dev/null 2>&1
grep -q "http://localhost:9999/n" "$SANDBOX/calls-open" && \
  ! grep -q -- "new-pane" "$SANDBOX/calls-cmux"
check $? "surface opens the default browser when the found workspace has no id"
rm -f "$SANDBOX/tree.json"

# --- surface: a failed tree call opens the default browser ------------------
touch "$SANDBOX/tree-fail"
: >"$SANDBOX/calls-cmux"
: >"$SANDBOX/calls-open"
CMUX_SURFACE_ID="SURF-CALLER-0000-0000-000000000000" CMUX_WORKSPACE_ID="w-stale" \
  "$BIN/obversa-surface" "http://localhost:9999/x" >/dev/null 2>&1
grep -q "http://localhost:9999/x" "$SANDBOX/calls-open" && \
  ! grep -q -- "new-pane" "$SANDBOX/calls-cmux"
check $? "surface opens the default browser when the tree call fails, never the stale workspace"
rm -f "$SANDBOX/tree-fail"

# --- surface: the watchdog force-stops a cmux that ignores the first signal --
touch "$SANDBOX/tree-hang"
: >"$SANDBOX/calls-open"
START="$(date +%s)"
CMUX_SURFACE_ID="SURF-CALLER-0000-0000-000000000000" CMUX_WORKSPACE_ID="w-stale" \
  "$BIN/obversa-surface" "http://localhost:9999/h" >/dev/null 2>&1
ELAPSED=$(( $(date +%s) - START ))
grep -q "http://localhost:9999/h" "$SANDBOX/calls-open" && [ "$ELAPSED" -lt 30 ]
check $? "watchdog force-stops a hung cmux and the caller gets the default browser"
rm -f "$SANDBOX/tree-hang"

# --- surface: a cancel during the lookup opens nothing -----------------------
touch "$SANDBOX/tree-hang"
: >"$SANDBOX/calls-open"
CMUX_SURFACE_ID="SURF-CALLER-0000-0000-000000000000" CMUX_WORKSPACE_ID="w-stale" \
  "$BIN/obversa-surface" "http://localhost:9999/c" >/dev/null 2>&1 &
SPID=$!
sleep 1
# TERM, not INT: bash runs backgrounded children with SIGINT ignored, and
# the script traps INT and TERM identically.
kill -TERM "$SPID" 2>/dev/null
CANCEL_RC=0
wait "$SPID" 2>/dev/null || CANCEL_RC=$?
[ "$CANCEL_RC" -eq 130 ] && ! grep -q "http://localhost:9999/c" "$SANDBOX/calls-open"
check $? "a cancel during the lookup exits 130 and opens nothing"
rm -f "$SANDBOX/tree-hang"

# --- surface: cmux failure falls back to the default browser ---------------
touch "$SANDBOX/cmux-fail"
: >"$SANDBOX/calls-open"
CMUX_WORKSPACE_ID="w-test" "$BIN/obversa-surface" "http://localhost:9999/z" >/dev/null 2>&1
grep -q "http://localhost:9999/z" "$SANDBOX/calls-open"
check $? "surface falls back to the default browser when new-pane fails"
rm -f "$SANDBOX/cmux-fail"

# --- surface: found in the tree, then new-pane fails → default browser ------
cat >"$SANDBOX/tree.json" <<'EOF'
{"windows": [{"ref": "window:1", "workspaces": [
  {"ref": "workspace:7", "id": "W-LIVE-0000-0000-0000-0000-0000000000",
   "panes": [{"ref": "pane:9", "surfaces": [
     {"ref": "surface:9", "id": "SURF-CALLER-0000-0000-000000000000", "title": "caller"}]}]}
]}]}
EOF
touch "$SANDBOX/cmux-fail"
: >"$SANDBOX/calls-open"
CMUX_SURFACE_ID="SURF-CALLER-0000-0000-000000000000" \
  "$BIN/obversa-surface" "http://localhost:9999/f" >/dev/null 2>&1
grep -q "http://localhost:9999/f" "$SANDBOX/calls-open"
check $? "surface falls back to the default browser when the resolved pane open fails"
rm -f "$SANDBOX/cmux-fail" "$SANDBOX/tree.json"

: >"$SANDBOX/calls-cmux"
CMUX_WORKSPACE_ID="w-test" "$BIN/obversa-surface" "http://localhost:1/y" --direction down >/dev/null 2>&1
grep -q -- "--direction down" "$SANDBOX/calls-cmux"
check $? "surface honors --direction"

# --- surface: outside cmux -------------------------------------------------
: >"$SANDBOX/calls-open"
"$BIN/obversa-surface" "http://localhost:9999/x" >/dev/null 2>&1
grep -q "http://localhost:9999/x" "$SANDBOX/calls-open"
check $? "surface falls back to the default browser outside cmux"

# --- surface: argument errors ----------------------------------------------
"$BIN/obversa-surface" >/dev/null 2>&1
[ $? -ne 0 ]
check $? "surface fails without a URL"

"$BIN/obversa-surface" "http://localhost:1/x" --direction sideways >"$SANDBOX/out" 2>"$SANDBOX/err"
RC=$?
[ $RC -eq 2 ] && grep -q "Usage" "$SANDBOX/err"
check $? "surface rejects an invalid direction with usage before opening anything"

# --- surface: no cmux binary at all → default browser ------------------------
mkdir -p "$SANDBOX/nocmux"
ln -sf "$SHIMS/open" "$SANDBOX/nocmux/open"
: >"$SANDBOX/calls-open"
PATH="$SANDBOX/nocmux:/usr/bin:/bin" CMUX_SURFACE_ID="SURF-CALLER-0000-0000-000000000000" \
  "$BIN/obversa-surface" "http://localhost:9999/nb" >/dev/null 2>&1
grep -q "http://localhost:9999/nb" "$SANDBOX/calls-open"
check $? "surface opens the default browser when no cmux binary exists"

"$BIN/obversa-surface" "http://localhost:1/x" --direction >"$SANDBOX/out" 2>"$SANDBOX/err"
RC=$?
[ $RC -eq 2 ] && grep -q "Usage" "$SANDBOX/err"
check $? "surface prints usage and exits 2 when --direction has no value"

# --- generator: a Project directory with a space still gets a default name --
mkdir -p "$SANDBOX/spaced/my app"
"$BIN/obversa-order-workspace" --project "$SANDBOX/spaced/my app" --shared "$SHRD" \
  --no-open --print-path | grep -q "my-app-"
check $? "generator sanitizes a spaced Project basename into the default name"

# --- generator: python3 preflight ------------------------------------------
mkdir -p "$SANDBOX/emptypath"
PATH="$SANDBOX/emptypath" /bin/bash "$BIN/obversa-order-workspace" \
  --project "$PROJ" --shared "$SHRD" --no-open >"$SANDBOX/out" 2>"$SANDBOX/err"
RC=$?
[ $RC -ne 0 ] && grep -q "python3" "$SANDBOX/err"
check $? "generator fails with a clear message when python3 is missing"

# --- plannotator handler ---------------------------------------------------
: >"$SANDBOX/calls-cmux"
CMUX_WORKSPACE_ID="w-test" "$BIN/obversa-plannotator-browser" "http://localhost:5599/#tok" >/dev/null 2>&1
grep -q -- "--url http://localhost:5599/#tok" "$SANDBOX/calls-cmux"
check $? "plannotator handler routes the review page into a cmux split"

"$BIN/obversa-plannotator-browser" >/dev/null 2>&1
[ $? -ne 0 ]
check $? "plannotator handler fails without a URL"

# --- project-local cmux config ---------------------------------------------
CFG="$REPO/.cmux/cmux.json" python3 - <<'PY'
import json, os, re, sys
raw = open(os.environ["CFG"]).read()
stripped = re.sub(r"^\s*//.*$", "", raw, flags=re.M)
doc = json.loads(stripped)
commands = doc["commands"]
assert any("obversa-order-workspace" in c.get("command", "") for c in commands), \
    "a command runs obversa-order-workspace"
sys.exit(0)
PY
check $? ".cmux/cmux.json parses and wires the Order Workspace command"

# --- the palette command string actually runs the generator -----------------
CMD="$(CFG="$REPO/.cmux/cmux.json" python3 - <<'PY'
import json, os, re
raw = open(os.environ["CFG"]).read()
stripped = re.sub(r"^\s*//.*$", "", raw, flags=re.M)
print(json.loads(stripped)["commands"][0]["command"])
PY
)"
: >"$SANDBOX/calls-code"
(cd "$REPO" && OBVERSA_SHARED_ROOT="$SHRD" sh -c "$CMD" >/dev/null 2>&1)
grep -q ".code-workspace" "$SANDBOX/calls-code" 2>/dev/null
check $? "the shipped palette command string opens a workspace end to end"

# --- the UNCOMMENT block yields valid configuration -------------------------
CFG="$REPO/.cmux/cmux.json" python3 - <<'PY'
import json, os, re, sys
lines = open(os.environ["CFG"]).read().splitlines()
out, active = [], False
for line in lines:
    s = line.strip()
    if "--- UNCOMMENT FROM HERE ---" in s:
        active = True
        continue
    if "--- UNCOMMENT TO HERE ---" in s:
        active = False
        continue
    if active and s.startswith("//"):
        out.append(re.sub(r"^(\s*)// ?", r"\1", line))
    else:
        out.append(line)
raw = "\n".join(out)
stripped = re.sub(r"^\s*//.*$", "", raw, flags=re.M)
doc = json.loads(stripped)
assert "actions" in doc, "uncommented block adds actions"
action = doc["actions"]["obversa.orderWorkspace"]
assert "obversa-order-workspace" in action["command"], "action runs the generator"
assert action["shortcut"], "action carries a shortcut"
assert "ui" in doc, "uncommented block adds the tab-bar button list"
sys.exit(0)
PY
check $? "uncommenting the marked block produces valid configuration"

# --- peer-send: durable entry, wakeup carries no content ---------------------
PCH="$SANDBOX/channel.md"
: >"$SANDBOX/calls-cmux"
OBVERSA_CHANNEL="$PCH" "$HERE/../bin/obversa-peer-send" --from tester --wake surface:9 "the actual content" >/dev/null 2>&1
grep -q "## .* tester" "$PCH" && grep -q "the actual content" "$PCH"
check $? "peer-send appends a titled entry to the channel"
grep -q "wakeup: check channel" "$SANDBOX/calls-cmux" && \
  ! grep -q "the actual content" "$SANDBOX/calls-cmux"
check $? "the wake cue never carries the message content"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
