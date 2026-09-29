#!/usr/bin/env python3
"""Tooltips, file panels and custom-drawn views, against a small fixture app
(scripts/fixtures/FixtureApp.swift) built into /tmp.

The fixture's window opens behind every other window and the app never
activates; every step must leave it in the background.

    python3 scripts/smoke_fixture.py [path/to/skfiy]
"""
import json
import os
import plistlib
import re
import subprocess
import sys

BINARY = sys.argv[1] if len(sys.argv) > 1 else ".build/debug/skfiy"
APP_PATH = "/tmp/skfiy-test/SkfiyFixture.app"
APP = "SkfiyFixture"
# Visible in file panels (Macintosh HD › Users › Shared) and not privacy-protected.
PANEL_DIR = "/Users/Shared/skfiy-panel-test"


class Client:
    def __init__(self):
        self.proc = subprocess.Popen([BINARY, "mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.next_id = 0
        self.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}})

    def request(self, method, params):
        self.next_id += 1
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()
        response = json.loads(self.proc.stdout.readline())
        if "error" in response:
            raise RuntimeError(response["error"])
        return response["result"]

    def call(self, tool, **arguments):
        before = frontmost()
        result = self.request("tools/call", {"name": tool, "arguments": {"app": APP, **arguments}})
        text = result["content"][0]["text"]
        if APP not in before and APP in frontmost():
            raise AssertionError(f"{tool} brought {APP} to the front")
        if result["isError"]:
            raise RuntimeError(f"{tool}: {text}")
        return text


def frontmost():
    asn = subprocess.run(["lsappinfo", "front"], capture_output=True, text=True).stdout.strip()
    return subprocess.run(["lsappinfo", "info", "-only", "name", asn], capture_output=True, text=True).stdout


def build():
    macos = APP_PATH + "/Contents/MacOS"
    os.makedirs(macos, exist_ok=True)
    with open(APP_PATH + "/Contents/Info.plist", "wb") as plist:
        plistlib.dump({"CFBundleIdentifier": "com.skfiy.fixture", "CFBundleName": APP, "CFBundleExecutable": APP,
                       "CFBundlePackageType": "APPL", "NSPrincipalClass": "NSApplication"}, plist)
    subprocess.run(["swiftc", "-O", "scripts/fixtures/FixtureApp.swift", "-o", f"{macos}/{APP}"], check=True)
    # Sandboxed, so its file panels come from the system's panel service like
    # those of TextEdit, Preview and App Store apps.
    entitlements = "/tmp/skfiy-test/fixture.entitlements"
    with open(entitlements, "wb") as plist:
        plistlib.dump({"com.apple.security.app-sandbox": True, "com.apple.security.files.user-selected.read-write": True}, plist)
    subprocess.run(["codesign", "--force", "-s", "-", "--entitlements", entitlements, APP_PATH], check=True, capture_output=True)


def index(tree, pattern):
    for line in tree.splitlines():
        if re.search(pattern, line):
            return re.search(r"\[(\d+)\]", line).group(1)
    raise AssertionError(f"no element matches {pattern!r}")


def status(tree, prefix="status"):
    match = re.search(prefix + r': ([^"]*)"', tree)
    return match.group(1) if match else "?"


def to_pixels(tree, x, y):
    """Screen point -> pixels of the latest screenshot."""
    match = re.search(r"Screenshot: (\d+)×\d+ px showing screen region x=(-?\d+) y=(-?\d+) w=(\d+)", tree)
    if not match:
        raise AssertionError("no screenshot")
    pixels, left, top, width = map(int, match.groups())
    scale = pixels / width
    return (x - left) * scale, (y - top) * scale


results = []


def case(name, run, expect):
    try:
        observed = run()
        ok = re.search(expect, observed) is not None
    except Exception as error:  # noqa: BLE001 - scored, not raised
        observed = f"error: {error}"
        ok = False
    results.append(ok)
    print(f"  {'✔' if ok else '✘'} {name}: {observed}")


def main():
    subprocess.run(["pkill", "-x", APP])
    subprocess.run(["rm", "-rf", PANEL_DIR])
    os.makedirs(f"{PANEL_DIR}/inner")
    with open(f"{PANEL_DIR}/inner/attach-me.txt", "w") as sample:
        sample.write("attach me\n")
    build()
    client = Client()
    try:
        client.call("get_app_state", app=APP_PATH)  # launches it in the background
        subprocess.run(["sleep", "0.5"])
        tree = client.call("get_app_state")

        case("the tooltip is in the tree", lambda: re.search(r'Button[^\n]*help="[^"]*"', tree).group(0), r'help="Archive the selected messages"')

        # File panels (served by another process) are filled in through
        # accessibility, only ever pointed at this test folder.
        def open_panel(button):
            now = client.call("get_app_state")
            client.call("click", element_index=index(now, r'Button "' + button + '"'))
            subprocess.run(["sleep", "1"])

        def choose():
            open_panel("Choose file…")
            client.call("file_dialog", path=f"{PANEL_DIR}/inner/attach-me.txt")
            return status(client.call("get_app_state"))
        case("file_dialog chooses a file in an Open panel", choose, re.escape(f"chosen {PANEL_DIR}/inner/attach-me.txt"))

        def save():
            open_panel("Save as…")
            client.call("file_dialog", path=f"{PANEL_DIR}/saved.txt")
            written = open(f"{PANEL_DIR}/saved.txt").read().strip() if os.path.exists(f"{PANEL_DIR}/saved.txt") else "nothing"
            return status(client.call("get_app_state")) + " | " + written
        case("file_dialog saves through a Save panel", save, re.escape(f"saved {PANEL_DIR}/saved.txt | saved by the fixture"))

        def refuse_then_replace():
            open_panel("Save as…")
            try:
                client.call("file_dialog", path=f"{PANEL_DIR}/saved.txt")
                refused = "not refused"
            except RuntimeError as error:
                refused = "refused" if "already exists" in str(error) else str(error)[:80]
            client.call("file_dialog", path=f"{PANEL_DIR}/saved.txt", overwrite=True)
            return refused + " | " + status(client.call("get_app_state"))
        case("file_dialog replaces only with overwrite", refuse_then_replace, r"^refused \| saved ")

        def save_document():
            answer = client.call("save_document", path=f"{PANEL_DIR}/via-menu.txt")
            written = open(f"{PANEL_DIR}/via-menu.txt").read().strip() if os.path.exists(f"{PANEL_DIR}/via-menu.txt") else "nothing"
            return answer.splitlines()[0][:60] + " | " + written
        case("save_document falls back to the app's Save panel", save_document, r"^Saved to .* \| saved by the fixture$")

        def hidden():
            open_panel("Choose file…")
            try:
                client.call("file_dialog", path="/tmp/skfiy-test/fixture.entitlements")
                answer = "not refused"
            except RuntimeError as error:
                answer = "refused: hidden" if "hidden" in str(error) else str(error)[:100]
            now = client.call("get_app_state")
            client.call("click", element_index=index(now, r'Button "Cancel"'))
            return answer
        case("file_dialog explains that hidden folders are out of reach", hidden, r"^refused: hidden$")

        def click_canvas(name):
            def run():
                now = client.call("get_app_state")
                match = re.search(re.escape(name) + r" at (\d+),(\d+) (\d+)x(\d+)", now)
                left, top, width, height = map(int, match.groups())
                x, y = to_pixels(now, left + width / 4, top + height / 2)  # the green half
                client.call("click", x=x, y=y)
                return status(client.call("get_app_state"))
            return run
        case("background click on a custom-drawn canvas", click_canvas("canvas"), r"^canvas green clicked$")

        client.call("press_key", key="cmd+q")
    finally:
        client.proc.stdin.close()
        subprocess.run(["pkill", "-x", APP])
        subprocess.run(["rm", "-rf", PANEL_DIR])
    front = frontmost()
    case("the fixture never came to the front", lambda: "never" if APP not in front else front, r"^never$")
    print(f"{sum(results)}/{len(results)} fixture checks passed")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
