#!/usr/bin/env bash
#
# Package a previously signed macOS .app into a signed DMG without mutating the
# app bundle's Finder metadata. Tauri's styled create-dmg path changes Finder
# attributes on the application, which makes `codesign --strict` reject the
# payload. This helper uses a clean staging copy and verifies the payload again
# after mounting the finished image.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: macOS DMG packaging requires Darwin" >&2
  exit 1
fi

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <signed-app-path> <output-dmg-path>" >&2
  exit 2
fi

APP_PATH="$1"
DMG_PATH="$2"

if [[ ! -d "$APP_PATH" || "$APP_PATH" != *.app ]]; then
  echo "error: signed app bundle not found: $APP_PATH" >&2
  exit 1
fi
if [[ "$DMG_PATH" != *.dmg ]]; then
  echo "error: output path must end in .dmg: $DMG_PATH" >&2
  exit 1
fi

APP_BASENAME="$(basename "$APP_PATH")"
VOLUME_NAME="${MACOS_DMG_VOLUME_NAME:-${APP_BASENAME%.app}}"
REQUIRE_NOTARIZATION="${REQUIRE_MACOS_NOTARIZATION:-0}"

case "$REQUIRE_NOTARIZATION" in
  0|1) ;;
  *)
    echo "error: REQUIRE_MACOS_NOTARIZATION must be 0 or 1" >&2
    exit 1
    ;;
esac

echo "==> Verifying source app signature before metadata-free staging: $APP_PATH"
codesign --verify --deep --verbose=2 "$APP_PATH"

SIGNING_IDENTITY="${MACOS_SIGNING_IDENTITY:-$(
  codesign -dv --verbose=4 "$APP_PATH" 2>&1 \
    | sed -n 's/^Authority=//p' \
    | head -1
)}"
if [[ -z "$SIGNING_IDENTITY" ]]; then
  echo "error: could not resolve the Developer ID identity from $APP_PATH" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tauri-dmg.XXXXXX")"
STAGE_DIR="$WORK_DIR/stage"
MOUNT_DIR="$WORK_DIR/mount"
MOUNTED=0

cleanup() {
  if [[ "$MOUNTED" == 1 ]]; then
    hdiutil detach "$MOUNT_DIR" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p "$STAGE_DIR" "$MOUNT_DIR" "$(dirname "$DMG_PATH")"

# Do not carry Finder, File Provider, quarantine, or resource-fork metadata
# into a signed application payload. The signature and stapled ticket are
# ordinary bundle content and are retained by ditto.
ditto --norsrc --noextattr --noqtn "$APP_PATH" "$STAGE_DIR/$APP_BASENAME"
ln -s /Applications "$STAGE_DIR/Applications"

echo "==> Verifying clean staging app"
codesign --verify --deep --strict --verbose=2 "$STAGE_DIR/$APP_BASENAME"
if [[ "$REQUIRE_NOTARIZATION" == 1 ]]; then
  spctl --assess --type exec --verbose=2 "$STAGE_DIR/$APP_BASENAME"
  xcrun stapler validate "$STAGE_DIR/$APP_BASENAME"
fi

echo "==> Creating DMG: $DMG_PATH"
hdiutil create \
  -fs HFS+ \
  -format UDZO \
  -volname "$VOLUME_NAME" \
  -srcfolder "$STAGE_DIR" \
  -ov \
  "$DMG_PATH"

echo "==> Signing DMG with $SIGNING_IDENTITY"
if [[ "$SIGNING_IDENTITY" == "-" ]]; then
  codesign --force --sign - "$DMG_PATH"
else
  codesign --force --sign "$SIGNING_IDENTITY" --timestamp "$DMG_PATH"
fi
codesign --verify --deep --strict --verbose=2 "$DMG_PATH"
hdiutil verify "$DMG_PATH"

echo "==> Mounting DMG to verify its embedded app"
hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT_DIR" "$DMG_PATH" >/dev/null
MOUNTED=1
codesign --verify --deep --strict --verbose=2 "$MOUNT_DIR/$APP_BASENAME"
if [[ "$REQUIRE_NOTARIZATION" == 1 ]]; then
  spctl --assess --type exec --verbose=2 "$MOUNT_DIR/$APP_BASENAME"
  xcrun stapler validate "$MOUNT_DIR/$APP_BASENAME"
fi
hdiutil detach "$MOUNT_DIR" >/dev/null
MOUNTED=0

echo "==> Safe DMG package verified: $DMG_PATH"
