#!/usr/bin/env bash
# Build, sign, notarize, package, and verify a direct-distribution macOS release.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

for arg in "$@"; do
  case "$arg" in
    --bundles|--bundles=*|--no-bundle)
      echo "error: release-macos.sh owns bundle selection; do not pass $arg" >&2
      exit 2
      ;;
  esac
done

NOTARY_ARGS=()
if [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY_PATH:-}" ]]; then
  if [[ ! -f "$APPLE_API_KEY_PATH" ]]; then
    echo "error: APPLE_API_KEY_PATH does not name a readable private key" >&2
    exit 1
  fi
  NOTARY_ARGS=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")
  unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  NOTARY_ARGS=(--apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID")
  unset APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
else
  echo "error: configure complete notarization credentials using either APPLE_API_KEY/APPLE_API_ISSUER/APPLE_API_KEY_PATH or APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID" >&2
  exit 1
fi

APP_IDENTIFIER="$(node -e "console.log(require('./src-tauri/tauri.conf.json').identifier)")"
SAFE_IDENTIFIER="${APP_IDENTIFIER//[^A-Za-z0-9._-]/_}"
RELEASE_TEMP_ROOT="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
export CARGO_TARGET_DIR="${MACOS_RELEASE_TARGET_DIR:-${CARGO_TARGET_DIR:-${RELEASE_TEMP_ROOT%/}/tauri-release-${SAFE_IDENTIFIER}}}"

TARGET_TRIPLE=""
NEXT_IS_TARGET=0
for arg in "$@"; do
  case "$arg" in
    --target) NEXT_IS_TARGET=1 ;;
    --target=*) TARGET_TRIPLE="${arg#--target=}" ;;
    *)
      if [[ "$NEXT_IS_TARGET" == 1 ]]; then
        TARGET_TRIPLE="$arg"
        NEXT_IS_TARGET=0
      fi
      ;;
  esac
done

echo "==> Building signed + notarized macOS app"
echo "==> Non-File-Provider target: $CARGO_TARGET_DIR"
pnpm exec tauri build --bundles app "$@"

BUNDLE_BASE="$CARGO_TARGET_DIR/release/bundle"
if [[ -n "$TARGET_TRIPLE" ]]; then
  BUNDLE_BASE="$CARGO_TARGET_DIR/$TARGET_TRIPLE/release/bundle"
fi
APP_PATHS=()
while IFS= read -r -d '' app_candidate; do
  APP_PATHS+=("$app_candidate")
done < <(find "$BUNDLE_BASE/macos" -maxdepth 1 -name '*.app' -print0 2>/dev/null)
if [[ ${#APP_PATHS[@]} -ne 1 ]]; then
  echo "error: expected exactly one macOS app under $BUNDLE_BASE/macos; found ${#APP_PATHS[@]}" >&2
  exit 1
fi
APP_PATH="${APP_PATHS[0]}"

echo "==> Normalizing app extended attributes"
xattr -cr "$APP_PATH"
xattr -d 'com.apple.fileprovider.fpfs#P' "$APP_PATH" 2>/dev/null || true
xattr -d com.apple.FinderInfo "$APP_PATH" 2>/dev/null || true

codesign --verify --deep --strict --verbose=2 "$APP_PATH"
spctl --assess --type exec --verbose=2 "$APP_PATH"
xcrun stapler validate "$APP_PATH"

APP_EXECUTABLE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP_PATH/Contents/Info.plist")"
APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_PATH/Contents/Info.plist")"
APP_ARCHES="$(lipo -archs "$APP_PATH/Contents/MacOS/$APP_EXECUTABLE")"
case " $APP_ARCHES " in
  *" arm64 "*" x86_64 "*) DMG_ARCH="universal" ;;
  *" x86_64 "*" arm64 "*) DMG_ARCH="universal" ;;
  " arm64 ") DMG_ARCH="aarch64" ;;
  " x86_64 ") DMG_ARCH="x86_64" ;;
  *)
    echo "error: unsupported application architectures: $APP_ARCHES" >&2
    exit 1
    ;;
esac
APP_NAME="$(basename "$APP_PATH" .app)"
SAFE_APP_NAME="${APP_NAME// /_}"
DMG_PATH="$BUNDLE_BASE/dmg/${SAFE_APP_NAME}_${APP_VERSION}_${DMG_ARCH}.dmg"

REQUIRE_MACOS_NOTARIZATION=1 ./scripts/package-macos-dmg.sh "$APP_PATH" "$DMG_PATH"

echo "==> Notarizing DMG: $DMG_PATH"
xcrun notarytool submit "$DMG_PATH" "${NOTARY_ARGS[@]}" --wait
xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"
codesign --verify --deep --strict --verbose=2 "$DMG_PATH"
hdiutil verify "$DMG_PATH"
spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG_PATH"

if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "BUNDLE_DIR=$BUNDLE_BASE" >> "$GITHUB_ENV"
fi

echo "==> Release artifacts verified"
echo "    app: $APP_PATH"
echo "    dmg: $DMG_PATH"
