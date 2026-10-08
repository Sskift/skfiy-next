# Command Line Tools ship the swift-testing macro plugin but SwiftPM does not
# pass its path; full Xcode does not need this.
TESTING_PLUGINS := /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing
TEST_FLAGS := $(if $(wildcard $(TESTING_PLUGINS)),-Xswiftc -plugin-path -Xswiftc $(TESTING_PLUGINS),)
PREFIX ?= $(HOME)/.local

.PHONY: build release test test-install embed-extension dist test-locked-use test-locked-use-plugin locked-use smoke smoke-fixture smoke-web smoke-browser compat install uninstall clean

build:
	swift build

# Only the skfiy binary; the experimental guardian is built by `make locked-use`.
# The embedded extension is refreshed first (a no-op unless browser-extension/ changed).
release: embed-extension
	swift build -c release --product skfiy

test:
	swift test $(TEST_FLAGS)

# install.sh, `skfiy setup` and `skfiy uninstall` in a throwaway HOME with fake
# claude/codex CLIs; checks that the real setup is untouched. No UI.
test-install: release
	scripts/test_install.sh .build/release/skfiy

# After changing browser-extension/: the binary carries a copy for `skfiy setup`.
embed-extension:
	scripts/embed_extension.sh

# The release tarball (universal, ad-hoc signed) in dist/; publishes nothing.
dist:
	scripts/release.sh

# Portable authorization and installer tests. Does not modify system policy.
test-locked-use:
	mkdir -p .build/locked-use-tests
	$(CC) -std=c11 -Wall -Wextra -Werror -ISources/LockedUseCore/include Sources/LockedUseCore/Lease.c Tests/LockedUseCoreTests/lease_test.c -lm -o .build/locked-use-tests/lease-test
	.build/locked-use-tests/lease-test
	python3 -m unittest discover -s Tests/LockedUseCoreTests -p 'test_*.py' -v

# Actual Apple plugin ABI, with mock identity/IPC; no system policy changes.
test-locked-use-plugin:
	mkdir -p .build/locked-use-tests
	xcrun clang -std=c11 -Wall -Wextra -Werror -ISources/LockedUseCore/include Tests/LockedUseCoreTests/plugin_test.c -framework Security -o .build/locked-use-tests/plugin-test
	.build/locked-use-tests/plugin-test

# Build only. System installation requires an explicit, separate sudo command.
locked-use:
	bash scripts/build_locked_use.sh

# Drives TextEdit in the background through the MCP server (TextEdit must not be running).
smoke: build
	python3 scripts/smoke_textedit.py .build/debug/skfiy

# Tooltips, file panels and custom-drawn views, against a small app built into /tmp.
smoke-fixture: build
	python3 scripts/smoke_fixture.py .build/debug/skfiy

# Web pages through the app tools, in a throwaway Chrome for Testing.
smoke-web: build
	scripts/test_browser.sh .build/debug/skfiy
	python3 scripts/smoke_chromium.py /tmp/skfiy-test/bin/skfiy

# Web pages through the browser bridge extension, in a throwaway Chrome for Testing.
smoke-browser: build
	python3 scripts/test_bridge_host.py .build/debug/skfiy
	scripts/test_browser.sh .build/debug/skfiy
	python3 scripts/smoke_browser.py /tmp/skfiy-test/bin/skfiy

# Real-app compatibility baseline (TextEdit, Preview, Finder, Chrome for Testing,
# Electron) with the target apps in the background; see docs/compatibility.md.
compat: build
	python3 scripts/compat_baseline.py .build/debug/skfiy --mode background
	python3 scripts/compat_baseline.py --report

# Installs the binary into $(PREFIX)/bin, then `skfiy setup`: the extension
# files (somewhere browsers may read them, not ~/Desktop or ~/Documents), the
# native messaging host and the Claude Code registration. Same as install.sh.
install: release
	./install.sh --binary .build/release/skfiy --prefix "$(PREFIX)"

uninstall:
	"$(PREFIX)/bin/skfiy" uninstall

clean:
	rm -rf .build
