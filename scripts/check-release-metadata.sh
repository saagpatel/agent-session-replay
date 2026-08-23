#!/usr/bin/env bash
# Fail closed when the consumer artifact identity or release entrypoints drift.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PACKAGE_VERSION="$(node -p "require('./package.json').version")"
TAURI_VERSION="$(node -e "console.log(require('./src-tauri/tauri.conf.json').version)")"
CARGO_VERSION="$(sed -n 's/^version = "\([^"]*\)"/\1/p' src-tauri/Cargo.toml | head -1)"
IDENTIFIER="$(node -e "console.log(require('./src-tauri/tauri.conf.json').identifier)")"

if [[ -z "$PACKAGE_VERSION" || "$PACKAGE_VERSION" != "$TAURI_VERSION" || "$PACKAGE_VERSION" != "$CARGO_VERSION" ]]; then
  echo "error: release version mismatch: package=$PACKAGE_VERSION tauri=$TAURI_VERSION cargo=$CARGO_VERSION" >&2
  exit 1
fi

if [[ -z "$IDENTIFIER" || "$IDENTIFIER" == com.example.* ]]; then
  echo "error: Tauri bundle identifier is empty or a placeholder: $IDENTIFIER" >&2
  exit 1
fi

for release_script in scripts/release-macos.sh scripts/package-macos-dmg.sh; do
  if [[ ! -x "$release_script" ]]; then
    echo "error: release entrypoint is not executable: $release_script" >&2
    exit 1
  fi
done

bash -n scripts/release-macos.sh scripts/package-macos-dmg.sh
echo "PASS: release metadata $PACKAGE_VERSION ($IDENTIFIER)"
