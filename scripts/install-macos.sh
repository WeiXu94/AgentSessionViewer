#!/usr/bin/env bash
# Build AgentSessionViewer.app in a temporary directory, install it into
# /Applications, and remove the temporary build on success or failure.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

APP_NAME="AgentSessionViewer.app"
APP_BIN="${APP_NAME%.app}"
DEST="${AGENT_SESSION_VIEWER_INSTALL_DESTINATION:-/Applications/$APP_NAME}"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-session-viewer.XXXXXX")"

cleanup() {
  rm -rf "$BUILD_DIR"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

case "$(uname -m)" in
  arm64) BUILD_ARCH="arm64" ;;
  x86_64) BUILD_ARCH="x64" ;;
  *)
    echo "error: unsupported macOS architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

cd "$ROOT_DIR"
echo "Building unpacked $BUILD_ARCH app in: $BUILD_DIR"
bun run build
bunx electron-builder --dir --mac --"$BUILD_ARCH" \
  --config.directories.output="$BUILD_DIR"

shopt -s nullglob
apps=("$BUILD_DIR"/mac*/"$APP_NAME")
shopt -u nullglob

if [ "${#apps[@]}" -ne 1 ]; then
  echo "error: expected one $APP_NAME under $BUILD_DIR, found ${#apps[@]}" >&2
  exit 1
fi
SRC="${apps[0]}"

echo "Installing: $SRC"
echo "      into: $DEST"

# Quit any running instance so the bundle can be replaced.
pkill -f "$DEST/Contents/MacOS/$APP_BIN" >/dev/null 2>&1 || true
sleep 1

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"

# The build is unsigned; clear quarantine and ad-hoc sign so it opens cleanly.
xattr -dr com.apple.quarantine "$DEST" >/dev/null 2>&1 || true
codesign --force --deep --sign - "$DEST" >/dev/null 2>&1 || true

if [ "${AGENT_SESSION_VIEWER_NO_LAUNCH:-0}" = "1" ]; then
  echo "Installed: $DEST"
else
  echo "Installed. Launching..."
  open "$DEST"
fi
