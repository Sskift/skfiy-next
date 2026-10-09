#!/bin/bash
# End-to-end test of install.sh, `skfiy setup`, `skfiy doctor --check` and
# `skfiy uninstall` in a throwaway HOME, with fake `claude` and `codex` CLIs
# first on a minimal PATH (the real ones are never reachable). No network, no
# UI, no permission prompts. Before and after, it snapshots the real setup
# (~/.local/bin/skfiy, the extension folder, native-host manifests, the skfiy
# entry in ~/.claude.json, ~/.codex/config.toml) and fails if anything changed.
#
#   scripts/test_install.sh [path/to/skfiy]     # default: builds .build/release/skfiy
#   SKFIY_TEST_FROM_SOURCE=1 scripts/test_install.sh   # also install.sh --from-source (~1 min)
set -uo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$repo" || exit 1

binary=${1:-}
if [ -z "$binary" ]; then
    swift build -c release --product skfiy >/dev/null || { echo "build failed"; exit 1; }
    binary="$repo/.build/release/skfiy"
fi
binary=$(cd "$(dirname "$binary")" && pwd -P)/$(basename "$binary")

before=$(bash scripts/real_setup_snapshot.sh)
work=$(cd "$(mktemp -d /tmp/skfiy-install-test.XXXXXX)" && pwd -P)
trap 'rm -rf "$work"' EXIT

passed=0
failed=0
check() {
    local description=$1
    shift
    if "$@" >/dev/null 2>&1; then
        passed=$((passed + 1)); echo "  ok    $description"
    else
        failed=$((failed + 1)); echo "  FAIL  $description"
    fi
}
contains() { grep -qF -- "$2" "$1"; }
lacks() { ! grep -qF -- "$2" "$1"; }
count() { local n; n=$(grep -cF -- "$2" "$1" 2>/dev/null); [ "${n:-0}" -eq "$3" ]; }
same_file() { cmp -s "$1" "$2"; }
mtime() { stat -f %m "$1"; }

# A throwaway home with Google Chrome "installed" (its support folder exists).
home="$work/home"
mkdir -p "$home/Library/Application Support/Google/Chrome"
fakebin="$work/bin"
mkdir -p "$fakebin" "$work/cli"
cp scripts/fixtures/fake-mcp-cli.sh "$fakebin/claude"
cp scripts/fixtures/fake-mcp-cli.sh "$fakebin/codex"
chmod +x "$fakebin/claude" "$fakebin/codex"
basepath=/usr/bin:/bin:/usr/sbin:/sbin

# Runs a command as the new user would: throwaway HOME, fake CLIs first on PATH.
as_user() {
    env -i HOME="$home" PATH="$fakebin:$basepath" FAKE_CLI_DIR="$work/cli" TMPDIR="$work" \
        SKFIY_RELEASE_URL="${release_url:-file:///nonexistent}" "$@"
}

installed="$home/.local/bin/skfiy"
support="$home/Library/Application Support"
extension="$support/skfiy/browser-extension"
manifest="$support/Google/Chrome/NativeMessagingHosts/com.skfiy.bridge.json"

echo "0. Codex is only added when asked"
home0="$work/home0"
mkdir -p "$home0" "$work/cli0"
env -i HOME="$home0" PATH="$fakebin:$basepath" FAKE_CLI_DIR="$work/cli0" TMPDIR="$work" \
    bash install.sh --binary "$binary" > "$work/out0" 2>&1
check "install exits 0" test $? -eq 0
check "claude added" count "$work/cli0/claude.log" "mcp add" 1
check "codex only asked, not changed" test "$(cat "$work/cli0/codex.log")" = "mcp get skfiy --json"
check "report says how to add codex" contains "$work/out0" "skfiy setup --codex"

echo "1. First install from a local binary"
as_user bash install.sh --binary "$binary" --codex > "$work/out1" 2>&1
check "install.sh exits 0" test $? -eq 0
check "binary installed in ~/.local/bin" same_file "$binary" "$installed"
check "extension files written" same_file browser-extension/manifest.json "$extension/manifest.json"
check "every extension file present" bash -c "diff -rq '$repo/browser-extension' '$extension'"
check "native host registered for Chrome" contains "$manifest" "\"path\" : \"$installed\""
check "claude: one add with the installed path" count "$work/cli/claude.log" "mcp add --scope user skfiy -- $installed mcp" 1
check "codex: one add with the installed path" count "$work/cli/codex.log" "mcp add skfiy -- $installed mcp" 1
check "report lists the extension step" contains "$work/out1" "Load unpacked"
check "report says ~/.local/bin is not on PATH" contains "$work/out1" "is not on your PATH"
check "permissions are reported, not prompted" contains "$work/out1" "Accessibility:"
check "setup gives a verification command that needs no PATH change" contains "$work/out1" "$installed doctor --check"
check "browser setup is explicitly optional" contains "$work/out1" "Optional: browser extension (desktop app tools work without it)"

echo "2. Running setup and install.sh again changes nothing"
manifest_time=$(mtime "$manifest"); extension_time=$(mtime "$extension/background.js")
as_user "$installed" setup > "$work/out2" 2>&1
check "setup exits 0" test $? -eq 0
as_user bash install.sh --binary "$binary" > "$work/out2b" 2>&1
check "install.sh again exits 0" test $? -eq 0
check "still exactly one claude add" count "$work/cli/claude.log" "mcp add" 1
check "no claude remove" count "$work/cli/claude.log" "mcp remove" 0
check "still exactly one codex add" count "$work/cli/codex.log" "mcp add" 1
check "manifest not rewritten" test "$manifest_time" = "$(mtime "$manifest")"
check "extension not rewritten" test "$extension_time" = "$(mtime "$extension/background.js")"
check "report says up to date" contains "$work/out2" "up to date"
check "report says registered" contains "$work/out2" "Claude Code: skfiy is registered"

echo "3. A setting is added once and then kept"
as_user "$installed" setup -e SKFIY_LOCKED_USE=direct > "$work/out3" 2>&1
check "setup -e exits 0" test $? -eq 0
check "claude entry replaced with the setting" contains "$work/cli/claude.log" "mcp add --scope user skfiy -e SKFIY_LOCKED_USE=direct -- $installed mcp"
check "codex entry replaced with the setting" contains "$work/cli/codex.log" "mcp add skfiy --env SKFIY_LOCKED_USE=direct -- $installed mcp"
as_user "$installed" setup > "$work/out3b" 2>&1
check "plain setup keeps it (no further add)" count "$work/cli/claude.log" "mcp add" 2
check "claude entry still has the setting" contains "$work/cli/claude.entry" "env=SKFIY_LOCKED_USE=direct"

echo "4. Moving the binary updates every registration"
as_user bash install.sh --binary "$binary" --prefix "$home/opt" > "$work/out4" 2>&1
check "install.sh --prefix exits 0" test $? -eq 0
check "claude points at the new path, setting kept" contains "$work/cli/claude.entry" "command=$home/opt/bin/skfiy"
check "codex points at the new path" contains "$work/cli/codex.entry" "command=$home/opt/bin/skfiy"
check "native host points at the new path" contains "$manifest" "$home/opt/bin/skfiy"
as_user bash install.sh --binary "$binary" > /dev/null 2>&1

echo "5. Install from a release tarball (file:// stands in for GitHub)"
mkdir -p "$work/releases/latest/download" "$work/stage"
cp "$binary" "$work/stage/skfiy"
tar -czf "$work/releases/latest/download/skfiy-macos-universal.tar.gz" -C "$work/stage" .
(cd "$work/releases/latest/download" && shasum -a 256 skfiy-macos-universal.tar.gz > skfiy-macos-universal.tar.gz.sha256)
rm -f "$installed"
release_url="file://$work/releases" as_user bash install.sh --release > "$work/out5" 2>&1
check "release install exits 0" test $? -eq 0
check "release binary installed" same_file "$binary" "$installed"
echo "0000000000000000000000000000000000000000000000000000000000000000  skfiy-macos-universal.tar.gz" > "$work/releases/latest/download/skfiy-macos-universal.tar.gz.sha256"
rm -f "$installed"
release_url="file://$work/releases" as_user bash install.sh --release > "$work/out5b" 2>&1
check "bad checksum fails" test $? -ne 0
check "bad checksum says so" contains "$work/out5b" "checksum mismatch"
check "bad checksum installs nothing" test ! -e "$installed"
as_user bash install.sh --binary "$binary" > /dev/null 2>&1

echo "5b. A clone still defaults to a release, never an implicit build"
(cd "$work/releases/latest/download" && shasum -a 256 skfiy-macos-universal.tar.gz > skfiy-macos-universal.tar.gz.sha256)
release_url="file://$work/releases" as_user env SKFIY_SOURCE_DIR=/nonexistent \
    bash install.sh --no-setup > "$work/out5c" 2>&1
check "plain install.sh downloads a release even inside the checkout" test $? -eq 0
check "release installed without compiling" same_file "$binary" "$installed"

echo "5c. Failed downloads preserve the install and never run build tools"
failurebin="$work/failurebin"
mkdir -p "$failurebin"
cat > "$failurebin/curl" <<'CURL'
#!/bin/bash
for url in "$@"; do :; done
if [ "${FAKE_CURL_STAGE:-asset}" = checksum ] && [[ "$url" != *.sha256 ]]; then
    exec /usr/bin/curl "$@"
fi
echo "simulated curl failure" >&2
printf '%s' "${FAKE_HTTP_STATUS:-000}"
exit "${FAKE_CURL_STATUS:-35}"
CURL
cat > "$failurebin/xcrun" <<'BUILD'
#!/bin/bash
touch "$TMPDIR/build-attempted"
exit 1
BUILD
cp "$failurebin/xcrun" "$failurebin/xcode-select"
cp "$failurebin/xcrun" "$failurebin/git"
chmod +x "$failurebin/"*
for scenario in connection missing checksum; do
    curl_status=35; http_status=000; curl_stage=asset
    if [ "$scenario" = missing ]; then curl_status=22; http_status=404; fi
    if [ "$scenario" = checksum ]; then curl_stage=checksum; fi
    release_url="file://$work/releases" as_user env PATH="$failurebin:$fakebin:$basepath" \
        FAKE_CURL_STATUS="$curl_status" FAKE_HTTP_STATUS="$http_status" FAKE_CURL_STAGE="$curl_stage" \
        bash install.sh --no-setup > "$work/out5-$scenario" 2>&1
    check "$scenario failure exits nonzero" test $? -ne 0
    check "$scenario failure preserves curl's diagnostic" contains "$work/out5-$scenario" "simulated curl failure"
    check "$scenario failure preserves the installed binary" same_file "$binary" "$installed"
    check "$scenario failure never invokes build tools" test ! -e "$work/build-attempted"
done
check "network failure suggests connection or proxy repair" contains "$work/out5-connection" "proxy settings"
check "404 explains the missing release file" contains "$work/out5-missing" "release file not found (HTTP 404)"
check "checksum download failure names the checksum URL" contains "$work/out5-checksum" ".tar.gz.sha256"

echo "6. Without claude, codex or a Chromium browser"
home2="$work/home2"
mkdir -p "$home2"
env -i HOME="$home2" PATH="$basepath" TMPDIR="$work" bash install.sh --binary "$binary" > "$work/out6" 2>&1
check "install exits 0 with no browser and no CLIs" test $? -eq 0
check "says no Chromium browser, as a note" contains "$work/out6" "no Chromium browser"
check "prints the claude command to paste" contains "$work/out6" "claude mcp add --scope user skfiy -- $home2/.local/bin/skfiy mcp"
check "extension files still installed" test -f "$home2/Library/Application Support/skfiy/browser-extension/manifest.json"

echo "7. doctor --check and the CLI"
as_user "$installed" doctor --check > "$work/out7" 2>&1
check "doctor --check reports permissions" contains "$work/out7" "Screen Recording:"
check "doctor --check sees the registration" contains "$work/out7" "Claude Code: skfiy runs"
check "doctor --check also sees the Codex registration" contains "$work/out7" "Codex: skfiy runs"
check "doctor --check sees the bridge" contains "$work/out7" "Browser bridge (Chrome): registered"
check "doctor --check reads the registered settings" contains "$work/out7" "Locked use: direct"
as_user env SKFIY_CURSER=0 "$installed" doctor --check > "$work/out7b" 2>&1
check "doctor flags a misspelled setting" contains "$work/out7b" "SKFIY_CURSER is set but skfiy does not read it"
as_user "$installed" setup --no-browser -e SKFIY_LOCKED_USE=1 > "$work/out7c" 2>&1
check "setup flags SKFIY_LOCKED_USE=1 given with -e" contains "$work/out7c" "SKFIY_LOCKED_USE=1 is not recognized"
as_user "$installed" doctor --check > "$work/out7d" 2>&1
check "doctor flags SKFIY_LOCKED_USE=1 in the registration" contains "$work/out7d" "SKFIY_LOCKED_USE=1 is not recognized"
as_user "$installed" setup --no-browser -e SKFIY_LOCKED_USE=direct > /dev/null 2>&1
as_user "$installed" setup --no-browser --no-codex -e SKFIY_LOCKED_USE=1 > /dev/null 2>&1
as_user "$installed" doctor --check > "$work/out7-settings" 2>&1
check "Codex settings do not hide invalid Claude settings" contains "$work/out7-settings" "Claude Code: SKFIY_LOCKED_USE=1 is not recognized"
check "doctor names the client using direct mode" contains "$work/out7-settings" "Codex: Locked use: direct"
as_user "$installed" setup --no-browser -e SKFIY_LOCKED_USE=direct > /dev/null 2>&1
as_user "$installed" stop --help > "$work/out7c" 2>&1
check "stop --help prints usage" contains "$work/out7c" "Usage:"
check "stop --help does not stop skfiy" test ! -e "$support/skfiy/stopped"
calls=$(wc -l < "$work/cli/claude.log")
as_user "$installed" install-browser-bridge --user-data-dir "$work/profile" > "$work/out7e" 2>&1
check "install-browser-bridge --user-data-dir writes that profile's host" contains "$work/profile/NativeMessagingHosts/com.skfiy.bridge.json" "\"path\" : \"$installed\""
check "and asks no MCP client" test "$calls" -eq "$(wc -l < "$work/cli/claude.log")"
as_user "$installed" bogus > "$work/out7d" 2>&1
check "unknown command is named" contains "$work/out7d" 'Unknown command "bogus"'
check "usage shows the real path" contains "$work/out7d" "-- $installed mcp"

if [ "${SKFIY_TEST_FROM_SOURCE:-}" = 1 ]; then
    echo "8. Build from source"
    rm -f "$installed"
    as_user env SKFIY_SOURCE_DIR="$repo" bash install.sh --from-source --no-setup > "$work/out8" 2>&1
    check "from-source install exits 0" test $? -eq 0
    check "from-source binary runs" as_user "$installed" --version
fi

echo "8b. Uninstalling a second copy leaves the main install alone"
as_user bash install.sh --binary "$binary" --prefix "$work/copy" --no-setup > /dev/null 2>&1
as_user "$work/copy/bin/skfiy" uninstall > "$work/out8b" 2>&1
check "second copy's uninstall exits 0" test $? -eq 0
check "second copy removed" test ! -e "$work/copy/bin/skfiy"
check "claude entry of the main install kept" contains "$work/cli/claude.entry" "command=$installed"
check "codex entry of the main install kept" contains "$work/cli/codex.entry" "command=$installed"
check "native host of the main install kept" contains "$manifest" "\"path\" : \"$installed\""
check "shared support folder kept" test -f "$extension/manifest.json"
check "says what it kept" contains "$work/out8b" "another copy"
as_user env SKFIY_SOURCE_DIR="$repo" "$installed" doctor --check > "$work/out8c" 2>&1
check "installer variables are not called typos" lacks "$work/out8c" "a typo?"
curl_help=$(cd "$work" && as_user bash -s -- --help < "$repo/install.sh" 2>&1)
check "install.sh --help works when piped" test -n "$curl_help"

echo "9. Uninstall"
as_user bash install.sh --uninstall > "$work/out9" 2>&1
check "uninstall exits 0" test $? -eq 0
check "claude entry removed" test ! -e "$work/cli/claude.entry"
check "codex entry removed" test ! -e "$work/cli/codex.entry"
check "native host removed" test ! -e "$manifest"
check "skfiy support folder removed" test ! -e "$support/skfiy"
check "binary removed" test ! -e "$installed"
check "says what is left" contains "$work/out9" "chrome://extensions"
as_user bash install.sh --binary "$binary" --no-setup > /dev/null 2>&1
check "--no-setup installs only the binary" test ! -e "$extension"

after=$(bash scripts/real_setup_snapshot.sh)
echo "10. The real setup is untouched"
check "real files unchanged (same mtimes and hashes)" test "$before" = "$after"
if [ "$before" != "$after" ]; then diff <(echo "$before") <(echo "$after"); fi

echo
echo "$passed passed, $failed failed"
if [ "$failed" -gt 0 ]; then
    echo "Outputs kept in $work"
    trap - EXIT
    exit 1
fi
