#!/bin/bash
# One-step install of skfiy (macOS computer use for Claude Code and other MCP clients).
#
#   curl -fsSL https://raw.githubusercontent.com/Sskift/skfiy-next/main/install.sh | bash
#
# Installs the prebuilt universal binary from the latest GitHub release when
# there is one, otherwise builds from source (needs Apple's Command Line
# Tools). The binary goes to ~/.local/bin/skfiy; then `skfiy setup` installs
# the browser extension files and bridge, registers skfiy with Claude Code
# when the claude CLI is installed (Codex too with --codex), checks
# permissions without prompting and lists what is left to do. Run it again
# to update; nothing needs sudo.
#
# Options (after `bash -s --` when piping from curl):
#   --from-source     build from source even when a release exists
#   --release         download the release even when run from a clone
#   --binary FILE     install this skfiy binary instead
#   --prefix DIR      install into DIR/bin (default ~/.local; also $SKFIY_PREFIX)
#   --version X.Y.Z   a given release instead of the latest
#   --no-setup        only install the binary
#   --uninstall       run `skfiy uninstall` (removes skfiy and everything setup did)
#   Anything else goes to `skfiy setup`, e.g. --codex or -e SKFIY_LOCKED_USE=direct.
#
# Environment: SKFIY_REPO (default Sskift/skfiy-next), SKFIY_RELEASE_URL (default
# https://github.com/$SKFIY_REPO/releases), SKFIY_SOURCE_DIR (a checkout to build).

set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { printf 'skfiy install: %s\n' "$*" >&2; exit 1; }

main() {
    local repo=${SKFIY_REPO:-Sskift/skfiy-next}
    local releases=${SKFIY_RELEASE_URL:-https://github.com/$repo/releases}
    local prefix=${SKFIY_PREFIX:-$HOME/.local}
    local mode="" binary="" version="" run_setup=1 uninstall=0
    local setup_args=()
    while [ $# -gt 0 ]; do
        case "$1" in
            --from-source) mode=source ;;
            --release) mode=release ;;
            --binary) [ $# -ge 2 ] || die "--binary needs a file"; binary=$2; mode=binary; shift ;;
            --prefix) [ $# -ge 2 ] || die "--prefix needs a folder"; prefix=$2; shift ;;
            --version) [ $# -ge 2 ] || die "--version needs a version"; version=${2#v}; shift ;;
            --no-setup) run_setup=0 ;;
            --uninstall) uninstall=1 ;;
            -h|--help)
                if [ -f "${BASH_SOURCE[0]:-}" ]; then sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
                else say "Options: --from-source, --release, --binary FILE, --prefix DIR, --version X.Y.Z, --no-setup, --uninstall;" \
                    "anything else goes to \`skfiy setup\` (e.g. --codex, -e SKFIY_LOCKED_USE=direct). Details: https://github.com/Sskift/skfiy-next#readme"; fi
                return 0 ;;
            -e|--env|--user-data-dir) [ $# -ge 2 ] || die "$1 needs a value"; setup_args+=("$1" "$2"); shift ;;
            *) setup_args+=("$1") ;;
        esac
        shift
    done

    [ "$(uname -s)" = Darwin ] || die "skfiy runs on macOS only."
    [ "$(id -u)" -ne 0 ] || die "run this as yourself, not with sudo: skfiy installs into your home folder."
    local macos major
    macos=$(sw_vers -productVersion)
    major=${macos%%.*}
    [ "$major" -ge 14 ] || die "skfiy needs macOS 14 (Sonoma) or later; this Mac has $macos."

    local target="$prefix/bin/skfiy"
    if [ "$uninstall" = 1 ]; then
        [ -x "$target" ] || die "no skfiy at $target (pass --prefix if you installed it elsewhere)."
        "$target" uninstall
        return
    fi

    work=$(mktemp -d "${TMPDIR:-/tmp}/skfiy-install.XXXXXX")
    trap 'rm -rf "${work:?}"' EXIT

    # A clone of the repository builds itself, like `make install`.
    local here=""
    if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
        here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
        [ -f "$here/Package.swift" ] && [ -d "$here/Sources/SkfiyKit" ] || here=""
    fi
    if [ -z "$mode" ]; then
        if [ -n "${SKFIY_SOURCE_DIR:-}" ] || [ -n "$here" ]; then mode=source; else mode=release; fi
    fi

    if [ "$mode" = release ]; then
        local status=0
        binary=$(download "$releases" "$version" "$work") || status=$?
        if [ "$status" = 3 ]; then
            [ -z "$version" ] || die "could not download skfiy $version from $releases."
            say "No prebuilt release found at $releases; building from source instead."
            mode=source
        elif [ "$status" != 0 ]; then
            exit "$status"
        fi
    fi
    if [ "$mode" = source ]; then
        binary=$(build "${SKFIY_SOURCE_DIR:-$here}" "$repo" "$work")
    fi
    [ -f "$binary" ] || die "no skfiy binary at $binary."
    "$binary" --version >/dev/null 2>&1 || die "$binary does not run on this Mac."

    # Into place through a rename, so a half-copied file is never run. Running
    # MCP servers keep working: each runs from its own hard link.
    mkdir -p "$prefix/bin"
    local staged="$prefix/bin/.skfiy.new.$$"
    cp "$binary" "$staged"
    chmod 755 "$staged"
    xattr -d com.apple.quarantine "$staged" 2>/dev/null || true
    mv -f "$staged" "$target"
    say "Installed skfiy $("$target" --version) at $target"

    if [ "$run_setup" = 1 ]; then
        say ""
        "$target" setup ${setup_args[@]+"${setup_args[@]}"}
    else
        say "Finish with: $target setup"
    fi
}

# Downloads and checks the release tarball; prints the path of the binary.
# Returns 3 when there is no release to download.
download() {
    local releases=$1 version=$2 work=$3
    local asset=skfiy-macos-universal.tar.gz url
    if [ -n "$version" ]; then url="$releases/download/v$version/$asset"; else url="$releases/latest/download/$asset"; fi
    say "Downloading $url" >&2
    curl -fsSL --retry 2 -o "$work/$asset" "$url" 2>/dev/null || return 3
    curl -fsSL --retry 2 -o "$work/$asset.sha256" "$url.sha256" 2>/dev/null || die "the release has no checksum file ($url.sha256)."
    local expected actual
    expected=$(awk '{print $1; exit}' "$work/$asset.sha256")
    actual=$(shasum -a 256 "$work/$asset" | awk '{print $1}')
    [ -n "$expected" ] && [ "$expected" = "$actual" ] || die "checksum mismatch for $asset (expected $expected, got $actual); nothing was installed."
    mkdir -p "$work/release"
    tar -xzf "$work/$asset" -C "$work/release"
    printf '%s\n' "$work/release/skfiy"
}

# Builds skfiy from a checkout (cloning one if needed); prints the binary's path.
build() {
    local source=$1 repo=$2 work=$3
    if ! xcode-select -p >/dev/null 2>&1 || ! xcrun --find swift >/dev/null 2>&1; then
        die "building skfiy needs Apple's Command Line Tools (Swift 6; about 1.3 GB, full Xcode is not needed).
Install them with:  xcode-select --install
then run this installer again."
    fi
    local swift_major
    swift_major=$(xcrun swift --version 2>/dev/null | sed -n 's/.*Swift version \([0-9]*\).*/\1/p' | head -1)
    [ "${swift_major:-0}" -ge 6 ] || die "skfiy needs Swift 6 or later (found ${swift_major:-none}); update the Command Line Tools: softwareupdate --list, or xcode-select --install."
    if [ -z "$source" ]; then
        command -v git >/dev/null || die "git is missing; install the Command Line Tools: xcode-select --install"
        say "Cloning https://github.com/$repo" >&2
        git clone --quiet --depth 1 "https://github.com/$repo.git" "$work/source" >&2
        source="$work/source"
    fi
    say "Building skfiy in $source (about a minute)…" >&2
    (cd "$source" && xcrun swift build -c release --product skfiy >&2) || die "the build failed; see the output above."
    printf '%s\n' "$source/.build/release/skfiy"
}

main "$@"
