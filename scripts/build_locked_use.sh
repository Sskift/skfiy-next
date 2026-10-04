#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $(uname -s) != Darwin ]]; then
  echo "The native locked-use components must be built on macOS." >&2
  exit 1
fi
swift build -c release --product skfiy-guardian
out=.build/locked-use
app="$out/LockedUse.app"
plugin="$out/SkfiyLockedUseAuthorization.bundle"
mkdir -p "$app/Contents/MacOS" "$plugin/Contents/MacOS"
cp .build/release/skfiy-guardian "$app/Contents/MacOS/skfiy-guardian"
cp locked-use/Guardian-Info.plist "$app/Contents/Info.plist"
cp locked-use/Plugin-Info.plist "$plugin/Contents/Info.plist"
xcrun clang -std=c11 -Wall -Wextra -Werror -mmacosx-version-min=14.0 -bundle \
  -ISources/LockedUseCore/include locked-use/AuthorizationPlugin.c \
  Sources/LockedUseCore/Native.c \
  -framework ApplicationServices -framework Security -framework SystemConfiguration \
  -o "$plugin/Contents/MacOS/SkfiyLockedUseAuthorization"
# No debugger/library-injection entitlements. The plugin pins the installed
# guardian's exact code hash, including for local ad-hoc builds.
identity=${SKFIY_SIGN_IDENTITY:--}
codesign --force --sign "$identity" --options runtime "$app"
codesign --force --sign "$identity" --options runtime "$plugin"
codesign --verify --strict "$app"
codesign --verify --strict "$plugin"
echo "Built $out. Installation is separate; see locked-use/GUARDIAN.md."
