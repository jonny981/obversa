#!/bin/bash
# Install the Obversa cmux glue.
#
# One command, no checkout:
#   curl -fsSL https://obversa.ai/install/cmux.sh | bash
#
# It fetches the five scripts and the Command Palette entry into
# $HOME/.obversa/cmux, adds the palette entry to the cmux configuration if it is
# not already there, and tells you the one line to put in your shell profile.
# It writes nothing else, touches no other configuration, and prints every
# path it writes before it writes it.
set -euo pipefail

REPO="${OBVERSA_CMUX_REPO:-https://raw.githubusercontent.com/jonny981/obversa/main}"
DEST="${OBVERSA_CMUX_HOME:-$HOME/.obversa/cmux}"
CMUX_CONFIG="${OBVERSA_CMUX_CONFIG:-$HOME/.config/cmux/cmux.json}"
SCRIPTS=(obversa-cmux-workspace obversa-order-workspace obversa-plannotator-browser obversa-surface obversa-whereis)

say() { printf '%s\n' "$*"; }
die() { printf 'obversa: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "the cmux glue is macOS only today: it falls back to \`open\` for the default browser"
command -v curl >/dev/null || die "curl is needed and is not on PATH"

say "Installing the Obversa cmux glue into $DEST"
mkdir -p "$DEST/bin"

for script in "${SCRIPTS[@]}"; do
  say "  $script"
  curl -fsSL "$REPO/hosts/cmux/bin/$script" -o "$DEST/bin/$script"
  chmod +x "$DEST/bin/$script"
done

# The palette entry names the launcher by absolute path, because cmux runs it
# from whatever directory the workspace is in.
ENTRY_NAME="Order Workspace"
if [ -f "$CMUX_CONFIG" ] && grep -q "$ENTRY_NAME" "$CMUX_CONFIG"; then
  say "Command Palette entry already present in $CMUX_CONFIG, left alone"
else
  mkdir -p "$(dirname "$CMUX_CONFIG")"
  if [ -f "$CMUX_CONFIG" ]; then
    cp "$CMUX_CONFIG" "$CMUX_CONFIG.before-obversa"
    say "Existing cmux configuration copied to $CMUX_CONFIG.before-obversa"
    say "Add this command to its \"commands\" array yourself; it is not edited for you:"
    printf '\n  { "name": "%s", "keywords": ["obversa"], "command": "%s" }\n\n' \
      "$ENTRY_NAME" "$DEST/bin/obversa-order-workspace"
  else
    cat > "$CMUX_CONFIG" <<CONFIG
{
  "schemaVersion": 1,
  "commands": [
    {
      "name": "$ENTRY_NAME",
      "keywords": ["obversa", "order", "workspace"],
      "command": "$DEST/bin/obversa-order-workspace"
    }
  ]
}
CONFIG
    say "Wrote $CMUX_CONFIG"
  fi
fi

say ""
say "Done. One line for your shell profile, so the commands are on your PATH:"
say ""
say "  export PATH=\"\$PATH:$DEST/bin\""
say ""
say "Then open a workspace with: obversa-cmux-workspace <repository-directory>"
say "Set the shared root once if you use one: export OBVERSA_SHARED_ROOT=<path>"
