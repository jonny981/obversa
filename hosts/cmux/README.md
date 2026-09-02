# cmux host glue

This directory holds the F0 host glue for cmux. It is setup, not a product:
configuration plus small scripts. No host fork, no new UI.

The glue removes app switching from the process flow. The correct editor
opens on the correct worktrees. Local web surfaces open in splits beside
the terminal. Outside cmux, each script falls back to the default browser
or fails with a clear message.

## Scripts

All commands live in `bin/`, on macOS (the default-browser fallback uses
`open`). Every one is placement glue on bash: `obversa-order-workspace`,
`obversa-surface`, `obversa-plannotator-browser`, `obversa-whereis`. The review command itself is `@obversa/source`'s bin —
this host only depends on that package so `node_modules/.bin/obversa-review`
exists here. Put `bin/` on your PATH or call the commands by full path.
Workspace-file generation and cmux-context parsing use `python3` for
correct JSON. The generator checks for `python3` before any work and fails
with a clear message without it; `--help` works either way.

### obversa-order-workspace

Generates the two-root Order editor workspace and opens it in the editor.
The binding follows `an internal note`: the
Project worktree and the Shared worktree are peer roots, and neither root
appears inside the other. The script rejects nested or identical roots.

```sh
obversa-order-workspace --shared ~/src/obversa-shared
```

- `--project <dir>` defaults to the Git top level of the current directory.
- `--shared <dir>` defaults to `$OBVERSA_SHARED_ROOT`.
- The workspace file lands in `~/.local/state/obversa/workspaces/` so that
  no worktree carries host state. Where portable workspace bindings live
  long term is an open question in `an internal note`.
- The default file name is the sanitized, length-bounded Project basename
  plus the full SHA-256 of the root pair (NUL-joined, so no two distinct
  pairs serialize alike). With default names, distinct Orders get
  distinct binding files, up to SHA-256 collision resistance. An explicit
  `--name` is the caller's responsibility: reusing a name overwrites that
  file. `--name` accepts letters, digits, `.`, `_`, and `-` only, must
  not start with `-`, and is bounded to 200 characters.
- The editor comes from `$OBVERSA_EDITOR_CMD`: one executable name or
  path, without arguments. The default is `code`.

### obversa-surface

Opens a URL as a browser surface beside the caller's terminal. Inside cmux
it opens a browser pane in the caller's workspace, split right by default.
Outside cmux it opens the default browser — that fallback is the intended
behavior, not an error. This is the one door for local webapps, and the
glue point for Callback Gate surfaces launched by a router.

The URL the glue receives is a one-time launch URL that opens the session
(single use, valid for a minute; the page URL with its token never enters
a process argument), and it is still the one door, so every command the
glue runs (`cmux`, macOS's `open`, the `python3` that reads the cmux tree,
and the coreutils the cmux route needs) runs by absolute path from a
fixed list of system directories (`/usr/bin`, `/bin`, `/usr/local/bin`,
`/opt/homebrew/bin`), never by a bare name looked up on `PATH`. A host
may name other directories in `OBVERSA_SYSTEM_BIN_DIRS` (colon-separated);
with no opener found, the URL is printed on stderr and nothing runs.

Every shell command under `bin/` is pinned by the SHA-256 of its content
in the boundary guard (`hostRules` in `scripts/check-boundaries.mjs`). A
change to one — any byte — fails the guard until the pin is reviewed and
updated with it: no text rule over shell closes, so the pin is the
closure, and the guard's text rules on these scripts are defence in
depth.

The target workspace resolves at call time from the live topology. The
`CMUX_*` environment is frozen at terminal start, and `cmux identify`
derives its caller answer from that same environment, so both name the
old workspace after a move — verified on cmux 0.64.20 with a real
surface move on 2026-08-25. The surface UUID is immutable, so the script
reads the JSON tree (`cmux tree --all --json`), matches the surface id
field exactly, and takes the enclosing workspace id. Titles are data in
the JSON form, so a title that contains a UUID cannot select the wrong
surface. With a surface id present, the tree is the only authority:
when the tree call fails, the topology is malformed or empty, or the
surface is not found, the URL opens in the default browser. The frozen
environment cannot tell a moved terminal from an unmoved one, so no
tree outcome falls back to it. The environment workspace is honored
only when no surface id exists at all — a manual invocation that set it
deliberately. A watchdog with a forced-stop escalation keeps a wedged
cmux from hanging the caller, a cancel during the lookup exits without
opening anything, and a failed pane open falls through to the default
browser.

```sh
obversa-surface http://localhost:4400/review --direction right
```

### obversa-plannotator-browser

The browser handler for Plannotator only. Plannotator invokes the value of
`PLANNOTATOR_BROWSER` with its review-page URL as the one argument. Point
that variable at this script and the review page opens in a cmux split.
No other tool reads `PLANNOTATOR_BROWSER`, so every other link keeps the
default browser.

### obversa-review (the source package's command)

Opens a git diff for inline review in a browser pane beside the terminal
and returns the annotations to the caller. The command is `@obversa/source`'s
bin — the package injects `@obversa/surfacer`'s session itself — and this
host takes it by public name: `pnpm exec obversa-review` from this
directory, or `node_modules/.bin/obversa-review` by path.

```sh
pnpm exec obversa-review                    # the working tree (git diff)
pnpm exec obversa-review -- --staged        # the staged changes
pnpm exec obversa-review -- --range main..HEAD # a ref range
```

The three modes are one choice: two of them on one command line is a
usage error, whatever their order. A diff holding an unresolved merge
conflict is refused whole, naming the conflicted path.

The page is placed through the absolute path in `OBVERSA_SURFACE_BIN` —
point it at this host's `obversa-surface` glue for a cmux split; nothing is
looked up on `PATH`, and with the variable unset the default browser opens
the page instead.

- `--cwd <dir>` runs against another repository directory; the review is
  captured from that repository's root whatever directory you start in.
- `--no-open` does not place the pane; the page URL is printed on stderr
  for you to open.
- `--app <name>` sets the surface app name, and with it the frame markers.

The result is one framed JSON object on stdout (`<<<REVIEW_RESULT_V1>>>` …
`<<<END_REVIEW_RESULT_V1>>>` for the default app name) with the decision and
the annotations; a one-line summary goes to stderr. The exit code is 0 when
the reviewer returned, 1 when the session ended any other way, and 2 for a
bad argument. The full page and result contract is in the public docs page
for the review surface.

## Setup

1. The Command Palette entry ships with the repository in `.cmux/cmux.json`.
   Open a cmux workspace on this repository, press the Command Palette
   shortcut, and run **Order Workspace**. The first run asks for trust —
   this is the cmux trust prompt for project-local commands.
2. For the command on every other workspace, add the same entry to
   `~/.config/cmux/cmux.json` with this script's absolute path (back the
   file up first). The project-local entry overrides the global one on
   Obversa checkouts, so the pair never conflicts:

   ```json
   "commands": [
     {
       "name": "Order Workspace",
       "command": "\"/absolute/path/to/hosts/cmux/bin/obversa-order-workspace\""
     }
   ]
   ```
3. Set the Shared root once per shell or workspace:
   `export OBVERSA_SHARED_ROOT=~/src/obversa-shared`.
4. Create workspaces through the host's own launcher, which binds both
   placement variables to this checkout's scripts for every terminal and
   agent in the workspace:

   ```sh
   hosts/cmux/bin/obversa-cmux-workspace <repository-directory>
   ```

   The binding is per launch host, never global. If an earlier setup put
   `PLANNOTATOR_BROWSER` in the `env` block of `~/.claude/settings.json`,
   remove that entry once workspaces are created through this command: a
   global variable binds every launch to one host, so a skill launched in
   another host would land here instead of where it started. For a workspace
   opened by hand, export `OBVERSA_SURFACE_BIN` as the absolute path of this
   host's `obversa-surface` in that workspace — the surfacer reads the
   variable only, never `PATH` — and outside cmux the surface opens the
   default browser.

5. Apply config changes with `cmux reload-config`.

The cmux action registry (tab-bar buttons and per-action shortcuts) is a
nightly feature today. `.cmux/cmux.json` carries the action block between
two UNCOMMENT markers. When the registry reaches the release channel,
uncomment every line between the markers — the leading comma is part of
the block — to get a tab-bar button and a `ctrl+cmd+o` binding for the
same command (`cmd+shift+o` belongs to cmux's own Reopen previous
session). The proof validates that the uncommented form parses.

## Proof

```sh
hosts/cmux/test/f0-proof.sh
hosts/cmux/test/f2b-placement-proof.sh
```

The proof is deterministic. It replaces `cmux`, `open`, and `code` with
recording shims, so no UI opens and no state leaves the sandbox.

Peer-agent chat is not a host command. The build team's rooms and their
sender live in the coordination workspace beside the checkouts, outside
this repository.
