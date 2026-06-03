#!/usr/bin/env bash
# Install the locally-built AgentSessionViewer.app into /Applications.
# Always re-packs first (unless --skip-pack is given). Ad-hoc signs so
# macOS Gatekeeper lets it launch on this machine.
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="AgentSessionViewer.app"
APP_BIN="${APP_NAME%.app}"
DEST="/Applications/$APP_NAME"
SKIP_PACK=false

for arg in "$@"; do
  case "$arg" in
    --skip-pack|-s) SKIP_PACK=true ;;
  esac
done

# Pick the .app matching this Mac's architecture
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

if [ "$SKIP_PACK" = false ]; then
  echo "Building & packaging app…"
  npm run pack:dir
fi

SRC="$(pick_app)"

if [ -z "$SRC" ] || [ ! -d "$SRC" ]; then
  echo "error: could not find $APP_NAME under release/. Run 'npm run pack:dir'." >&2
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
