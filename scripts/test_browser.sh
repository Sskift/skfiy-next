#!/bin/bash
# Starts a throwaway Chrome for Testing in the background with the skfiy
# extension and the web fixture, for scripts/smoke_chromium.py and
# scripts/smoke_browser.py. Nothing here touches your own browser profile.
#
#   scripts/test_browser.sh [path/to/skfiy]
set -euo pipefail
cd "$(dirname "$0")/.."
SKFIY=${1:-.build/debug/skfiy}
WORK=/tmp/skfiy-test            # outside ~/Desktop etc., so no privacy prompts
PROFILE=$WORK/profile
CACHE=$HOME/.cache/skfiy-test

pkill -f "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" || true
sleep 2
pkill -9 -f "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" 2>/dev/null || true

mkdir -p "$WORK/bin" "$WORK/web" "$WORK/extension"
rm -f "$WORK/bin/skfiy" && cp "$SKFIY" "$WORK/bin/skfiy"   # replace, never overwrite a signed binary in place
cp browser-extension/* "$WORK/extension/"
cp scripts/fixtures/web.html "$WORK/web/"
rm -rf "$PROFILE"   # a fresh profile, so no stale extension service worker is cached
"$WORK/bin/skfiy" install-browser-bridge --user-data-dir "$PROFILE" >/dev/null

if ! curl -s -o /dev/null http://127.0.0.1:8765/web.html; then
  # Fully detached: holding the caller's stdout would keep a pipe open forever.
  nohup python3 -m http.server 8765 --bind 127.0.0.1 --directory "$WORK/web" </dev/null >"$WORK/server.log" 2>&1 &
  disown
fi

APP=$(ls -d "$CACHE"/chrome/*/chrome-mac-arm64/"Google Chrome for Testing.app" 2>/dev/null | tail -1)
if [ -z "$APP" ]; then
  npx -y @puppeteer/browsers install chrome@stable --path "$CACHE" >/dev/null
  APP=$(ls -d "$CACHE"/chrome/*/chrome-mac-arm64/"Google Chrome for Testing.app" | tail -1)
fi


# Launch without activating (NSWorkspace, activates = false).
cat > "$WORK/launch.swift" <<'SWIFT'
import AppKit
let configuration = NSWorkspace.OpenConfiguration()
configuration.activates = false
configuration.addsToRecentItems = false
configuration.arguments = Array(CommandLine.arguments.dropFirst(2))
var launched: NSRunningApplication?
var done = false
NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: CommandLine.arguments[1]), configuration: configuration) { app, _ in launched = app; done = true }
while !done { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
// Chrome may activate itself while starting. Only then, hand the front back to
// whatever the user had before it; never override the user's own switches.
var userApp = NSWorkspace.shared.frontmostApplication
for _ in 0..<100 {
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    guard let front = NSWorkspace.shared.frontmostApplication else { continue }
    if front.processIdentifier == launched?.processIdentifier {
        if let userApp, userApp.processIdentifier != front.processIdentifier { userApp.activate(options: []) }
    } else {
        userApp = front
    }
}
SWIFT
swiftc -O "$WORK/launch.swift" -o "$WORK/launch" 2>/dev/null
"$WORK/launch" "$APP" --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check \
  --disable-search-engine-choice-screen --disable-features=DisableLoadExtensionCommandLineSwitch \
  --load-extension="$WORK/extension" http://127.0.0.1:8765/web.html
for _ in $(seq 1 30); do
  "$WORK/bin/skfiy" call browser_tabs '{}' >/dev/null 2>&1 && { echo "test browser ready ($WORK/bin/skfiy)"; exit 0; }
  sleep 0.5
done
echo "the extension did not connect" >&2
exit 1
