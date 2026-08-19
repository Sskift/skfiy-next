#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER_DIR="$ROOT_DIR/macos-helper"
DIST_DIR="$ROOT_DIR/dist"

swift package --package-path "$HELPER_DIR" clean
swift build --package-path "$HELPER_DIR" -c release

BIN_DIR="$(swift build --package-path "$HELPER_DIR" -c release --show-bin-path)"
mkdir -p "$DIST_DIR"
cp "$BIN_DIR/skfiy-helper" "$DIST_DIR/skfiy-helper"
chmod +x "$DIST_DIR/skfiy-helper"

echo "Built helper: $DIST_DIR/skfiy-helper"
