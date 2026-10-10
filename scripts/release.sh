#!/bin/bash
# Builds the release tarball that install.sh downloads: one universal
# (arm64 + x86_64), ad-hoc signed skfiy binary plus the READMEs. Publishes
# nothing; the Release workflow (.github/workflows/release.yml) uploads dist/.
#
#   scripts/release.sh            # version from Sources/SkfiyKit/MCPServer.swift
#   scripts/release.sh v0.8.0     # fails unless the tag matches that version
#
# Output: dist/skfiy-macos-universal.tar.gz and dist/skfiy-macos-universal.tar.gz.sha256
set -euo pipefail
cd "$(dirname "$0")/.."

version=$(sed -n 's/^public let skfiyVersion = "\(.*\)"$/\1/p' Sources/SkfiyKit/MCPServer.swift)
[ -n "$version" ] || { echo "release: could not read skfiyVersion" >&2; exit 1; }
if [ -n "${1:-}" ] && [ "${1#v}" != "$version" ]; then
    echo "release: tag $1 does not match skfiyVersion $version" >&2
    exit 1
fi

scripts/embed_extension.sh  # the binary carries browser-extension/; a no-op when it is current
# One architecture per build, then lipo: with two --arch flags SwiftPM hands
# the build to Xcode's build system, which fails on this package.
slices=()
for arch in arm64 x86_64; do
    flags=(-c release --arch "$arch" --product skfiy --scratch-path ".build/release-$arch")
    swift build "${flags[@]}"
    slices+=("$(swift build "${flags[@]}" --show-bin-path)/skfiy")
done
mkdir -p .build/universal
binary=.build/universal/skfiy
lipo -create -output "$binary" "${slices[@]}"
archs=$(lipo -archs "$binary")
for arch in arm64 x86_64; do
    case " $archs " in *" $arch "*) ;; *) echo "release: $arch missing (has $archs)" >&2; exit 1 ;; esac
done
codesign --force --sign - "$binary"
[ "$("$binary" --version)" = "$version" ] || { echo "release: the binary does not report $version" >&2; exit 1; }

rm -rf dist
mkdir -p dist/stage
cp "$binary" dist/stage/skfiy
cp README.md README.en.md CHANGELOG.md dist/stage/
cp -R docs locked-use dist/stage/
[ -f LICENSE ] && cp LICENSE dist/stage/
asset=skfiy-macos-universal.tar.gz
tar -czf "dist/$asset" -C dist/stage .
rm -rf dist/stage
(cd dist && shasum -a 256 "$asset" > "$asset.sha256")
echo "skfiy $version: dist/$asset ($(du -h "dist/$asset" | cut -f1)), sha256 $(cut -c1-16 "dist/$asset.sha256")…"
