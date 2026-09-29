# Command Line Tools ship the swift-testing macro plugin but SwiftPM does not
# pass its path; full Xcode does not need this.
TESTING_PLUGINS := /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing
TEST_FLAGS := $(if $(wildcard $(TESTING_PLUGINS)),-Xswiftc -plugin-path -Xswiftc $(TESTING_PLUGINS),)
PREFIX ?= $(HOME)/.local
EXTENSION_DIR := $(HOME)/Library/Application Support/skfiy/browser-extension

.PHONY: build release test smoke smoke-fixture smoke-web smoke-browser install clean

build:
	swift build

release:
	swift build -c release

test:
	swift test $(TEST_FLAGS)

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
