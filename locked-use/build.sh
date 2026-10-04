#!/bin/bash
set -euo pipefail
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
build_dir="$repo_dir/.build/locked-use"
plugin_dir="$build_dir/SkfiyLockedUse.bundle"

plugin_only=false
adhoc_for_tests=false
for argument in "$@"; do
  case "$argument" in
    --plugin-only) plugin_only=true ;;
    --adhoc-for-tests) adhoc_for_tests=true ;;
    *) printf 'Unknown option: %s\n' "$argument" >&2; exit 2 ;;
  esac
done
signing_identity="${SKFIY_CODESIGN_IDENTITY:-}"
if [[ -z "$signing_identity" || "$signing_identity" == "-" ]]; then
  if [[ "$adhoc_for_tests" != true ]]; then
    printf '%s\n' 'Set SKFIY_CODESIGN_IDENTITY to an Apple-issued code-signing identity before building installable locked-use components.' \
      'macOS rejects ad-hoc authorization plug-ins in SecurityAgentHelper. Use --adhoc-for-tests only for local build/unit checks; that output cannot be installed.' >&2
    exit 2
  fi
  signing_identity=-
fi
signing_options=(--force --sign "$signing_identity")
if [[ "$signing_identity" != "-" ]]; then signing_options+=(--timestamp); fi

if [[ "$plugin_only" != true ]]; then
  cd "$repo_dir"
  swift build -c release --product skfiy
  swift build -c release --product skfiy-locked-guardian
  codesign "${signing_options[@]}" --options runtime --identifier com.skfiy.mcp "$repo_dir/.build/release/skfiy"
  codesign "${signing_options[@]}" --options runtime --identifier com.skfiy.LockedUseGuardian "$repo_dir/.build/release/skfiy-locked-guardian"
fi

mkdir -p "$plugin_dir/Contents/MacOS"
cat > "$plugin_dir/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.skfiy.LockedUseAuthorizationPlugin</string>
<key>CFBundleExecutable</key><string>SkfiyLockedUse</string>
<key>CFBundleName</key><string>Skfiy Locked Use Authorization</string>
<key>CFBundlePackageType</key><string>BNDL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
</dict></plist>
PLIST
clang -O2 -Wall -Wextra -Werror -bundle -fvisibility=hidden \
  -arch arm64 -arch x86_64 -mmacosx-version-min=14.0 \
  -I "$repo_dir/locked-use/Support/include" \
  "$repo_dir/locked-use/AuthorizationPlugin.c" "$repo_dir/locked-use/Support/Support.c" \
  -framework CoreFoundation -framework Security -framework SystemConfiguration -lbsm \
  -o "$plugin_dir/Contents/MacOS/SkfiyLockedUse"
codesign "${signing_options[@]}" --identifier com.skfiy.LockedUseAuthorizationPlugin "$plugin_dir"
codesign --verify --strict "$plugin_dir"
if [[ "$signing_identity" != "-" ]]; then
  codesign --verify --strict --test-requirement '=anchor apple generic and certificate leaf[subject.OU] exists' "$plugin_dir"
else
  printf '%s\n' 'Ad-hoc test build only: macOS cannot load this authorization plug-in; installation is disabled.' >&2
fi
printf 'Built %s\n' "$plugin_dir"
