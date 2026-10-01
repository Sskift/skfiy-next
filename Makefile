# Command Line Tools ship the swift-testing macro plugin but SwiftPM does not
# pass its path; full Xcode does not need this.
TESTING_PLUGINS := /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing
TEST_FLAGS := $(if $(wildcard $(TESTING_PLUGINS)),-Xswiftc -plugin-path -Xswiftc $(TESTING_PLUGINS),)
PREFIX ?= $(HOME)/.local
EXTENSION_DIR := $(HOME)/Library/Application Support/skfiy/browser-extension

.PHONY: build release test test-locked-use test-locked-use-plugin locked-use smoke smoke-fixture smoke-web smoke-browser install clean

build:
	swift build

release:
	swift build -c release

test:
	swift test $(TEST_FLAGS)

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
	scripts/test_browser.sh .build/debug/skfiy
	python3 scripts/smoke_browser.py /tmp/skfiy-test/bin/skfiy

# Installs the binary, copies the extension somewhere browsers may read it
# (not ~/Desktop or ~/Documents), and registers the native messaging host.
install: release
	install -d $(PREFIX)/bin
	rm -f $(PREFIX)/bin/skfiy
	cp .build/release/skfiy $(PREFIX)/bin/skfiy
	install -d "$(EXTENSION_DIR)"
	cp browser-extension/* "$(EXTENSION_DIR)/"
	$(PREFIX)/bin/skfiy install-browser-bridge

clean:
	rm -rf .build
