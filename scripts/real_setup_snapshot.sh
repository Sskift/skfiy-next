#!/bin/bash
# Prints mtimes and hashes of the user's real skfiy setup, so install tests can
# prove they left it alone: run it before and after, then diff the outputs.
# Read-only. ~/.claude.json is rewritten by every running Claude Code session,
# so only its skfiy entry is compared, not the whole file.
real_home=$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
real_home=${real_home:-/Users/$(id -un)}

describe() {
    if [ -e "$1" ]; then
        printf '%s %s %s\n' "$(stat -f '%m %z' "$1")" "$(shasum -a 256 "$1" | cut -c1-64)" "$1"
    else
        printf 'absent %s\n' "$1"
    fi
}

describe "$real_home/.local/bin/skfiy"
find "$real_home/Library/Application Support/skfiy" -type f -not -path '*/browsers/*' 2>/dev/null | sort | while read -r file; do
    describe "$file"
done
find "$real_home/Library/Application Support" -maxdepth 5 -path '*NativeMessagingHosts/com.skfiy.bridge.json' 2>/dev/null | sort | while read -r file; do
    describe "$file"
done
if [ -f "$real_home/.claude.json" ]; then
    printf 'claude.json skfiy entry: %s\n' "$(plutil -extract mcpServers.skfiy json -o - "$real_home/.claude.json" 2>&1 | shasum -a 256 | cut -c1-64)"
fi
describe "$real_home/.codex/config.toml"
