#!/usr/bin/env bash
# Install the locally-built AgentSessionViewer.app into /Applications.
# Builds first if no packaged app is found. Ad-hoc signs the (unsigned) app so
# macOS Gatekeeper lets it launch on this machine.
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="AgentSessionViewer.app"
APP_BIN="${APP_NAME%.app}"
DEST="/Applications/$APP_NAME"

# Pick the .app matching this Mac's architecture (arm64 -> release/mac-arm64,
# Intel -> release/mac), preferring a universal build, then falling back to whatever exists.
pick_app() {
  local order
  if [ "$(uname -m)" = "arm64" ]; then
    order="release/mac-universal release/mac-arm64 release/mac"
  else
    order="release/mac-universal release/mac release/mac-arm64"
  fi
  for d in $order; do
    [ -d "$d/$APP_NAME" ] && { echo "$d/$APP_NAME"; return; }
  done
  ls -dt release/mac*/"$APP_NAME" 2>/dev/null | head -1 || true
}

SRC="$(pick_app)"

if [ -z "$SRC" ]; then
  echo "No built app found — building for macOS first…"
  npm run package:mac
  SRC="$(pick_app)"
fi

if [ -z "$SRC" ] || [ ! -d "$SRC" ]; then
  echo "error: could not find $APP_NAME under release/. Run 'npm run package:mac'." >&2
  exit 1
fi

echo "Installing: $SRC"
echo "      into: $DEST"

# Quit any running instance so the bundle can be replaced.
osascript -e "tell application \"$APP_BIN\" to quit" >/dev/null 2>&1 || true
pkill -f "$DEST/Contents/MacOS/$APP_BIN" >/dev/null 2>&1 || true
sleep 1

rm -rf "$DEST"
cp -R "$SRC" "$DEST"

# The build is unsigned; clear quarantine and ad-hoc sign so it opens cleanly.
xattr -dr com.apple.quarantine "$DEST" >/dev/null 2>&1 || true
codesign --force --deep --sign - "$DEST" >/dev/null 2>&1 || true

echo "✓ Installed. Launching…"
open "$DEST"
