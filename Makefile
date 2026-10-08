# Command Line Tools ship the swift-testing macro plugin but SwiftPM does not
# pass its path; full Xcode does not need this.
TESTING_PLUGINS := /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing
TEST_FLAGS := $(if $(wildcard $(TESTING_PLUGINS)),-Xswiftc -plugin-path -Xswiftc $(TESTING_PLUGINS),)
PREFIX ?= $(HOME)/.local

.PHONY: build release test test-install embed-extension dist smoke smoke-fixture smoke-web smoke-browser compat install uninstall clean

build:
	swift build

# The embedded extension is refreshed first (a no-op unless browser-extension/ changed).
release: embed-extension
	swift build -c release

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

# Drives TextEdit in the background through the MCP server (TextEdit must not be running).
smoke: build
	python3 scripts/smoke_textedit.py .build/debug/skfiy

# Tooltips, file panels and custom-drawn views, against a small app built into /tmp.
smoke-fixture: build
	python3 scripts/smoke_fixture.py .build/debug/skfiy

# Web pages through the app tools, in a throwaway Chrome for Testing.
smoke-web: build
	python3 scripts/compat_baseline.py .build/debug/skfiy --test-browser
	python3 scripts/smoke_chromium.py .build/debug/skfiy

# Web pages through the browser bridge extension, in a throwaway Chrome for Testing.
smoke-browser: build
	python3 scripts/test_bridge_host.py .build/debug/skfiy
	python3 scripts/compat_baseline.py .build/debug/skfiy --test-browser
	python3 scripts/smoke_browser.py .build/debug/skfiy

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
