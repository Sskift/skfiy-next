#!/usr/bin/env python3
"""Tooltips, file panels and custom-drawn views, against a small fixture app
(scripts/fixtures/FixtureApp.swift) built into /tmp.

The fixture's window opens behind every other window and the app never
activates; every step must leave it in the background.

    python3 scripts/smoke_fixture.py [path/to/skfiy] [--front]

With --front it also brings the fixture forward for about a second, with an
approval this script gives, once you have been idle for 10 s: run_in_front
choosing from a context menu.
"""
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import harness  # noqa: E402
from harness import APPROVE, DECLINE, case, frontmost, index, results, status  # noqa: E402
from scenario import idle_seconds  # noqa: E402

FRONT = "--front" in sys.argv
ARGS = [arg for arg in sys.argv[1:] if arg != "--front"]
BINARY = ARGS[0] if ARGS else ".build/debug/skfiy"
APP_PATH = "/tmp/skfiy-test/SkfiyFixture.app"
APP = "SkfiyFixture"
# Visible in file panels (Macintosh HD › Users › Shared) and not privacy-protected.
PANEL_DIR = "/Users/Shared/skfiy-panel-test"
ACTION_LOG = f"/tmp/skfiy-fixture-actions-{os.getpid()}.jsonl"  # never the user's log


class Client(harness.Client):
    def __init__(self, answer=None):
        super().__init__(BINARY, env={"SKFIY_ACTION_LOG": ACTION_LOG}, answer=answer)

    def call(self, tool, **arguments):
        before = frontmost()
        result = super().call(tool, allow_error=True, **{"app": APP, **arguments})
        if APP not in before and APP in frontmost():
            raise AssertionError(f"{tool} brought {APP} to the front")
        if result["is_error"]:
            raise RuntimeError(f"{tool}: {result['text']}")
        return result["text"]


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
        plistlib.dump({"com.apple.security.app-sandbox": True, "com.apple.security.files.user-selected.read-write": True,
                       "com.apple.security.network.client": True}, plist)  # web views need it even for inline pages
    subprocess.run(["codesign", "--force", "-s", "-", "--entitlements", entitlements, APP_PATH], check=True, capture_output=True)


def clipboard_fingerprint():
    """The types and sizes on the user's clipboard, never its content."""
    script = ('ObjC.import("AppKit"); var items = $.NSPasteboard.generalPasteboard.pasteboardItems; var out = [];'
              'for (var i = 0; i < items.count; i++) { var item = items.objectAtIndex(i); var types = item.types;'
              ' for (var j = 0; j < types.count; j++) { var type = types.objectAtIndex(j).js;'
              ' if (type == "org.nspasteboard.TransientType") continue; var data = item.dataForType(type);'
              ' out.push(i + ":" + type + ":" + (data.isNil() ? 0 : data.length)); } } out.join(",")')
    return subprocess.run(["osascript", "-l", "JavaScript", "-e", script], capture_output=True, text=True).stdout.strip()


def to_pixels(tree, x, y):
    """Screen point -> pixels of the latest screenshot."""
    match = re.search(r"Screenshot: (\d+)×\d+ px showing screen region x=(-?\d+) y=(-?\d+) w=(\d+)", tree)
    if not match:
        raise AssertionError("no screenshot")
    pixels, left, top, width = map(int, match.groups())
    scale = pixels / width
    return (x - left) * scale, (y - top) * scale


def green_half(caller, name):
    """Pixels of the green half of a canvas in the latest screenshot."""
    now = caller.call("get_app_state", window="skfiy fixture")
    match = re.search(re.escape(name) + r" at (\d+),(\d+) (\d+)x(\d+)", now)
    left, top, width, height = map(int, match.groups())
    return to_pixels(now, left + width / 4, top + height / 2)


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
        tree = client.call("get_app_state", window="skfiy fixture")

        case("the tooltip is in the tree", lambda: re.search(r'Button[^\n]*help="[^"]*"', tree).group(0), r'help="Archive the selected messages"')

        # File panels (served by another process) are filled in through
        # accessibility, only ever pointed at this test folder.
        def open_panel(button):
            now = client.call("get_app_state", window="skfiy fixture")
            client.call("click", element_index=index(now, r'Button "' + button + '"'))
            subprocess.run(["sleep", "1"])

        def choose():
            open_panel("Choose file…")
            client.call("file_dialog", path=f"{PANEL_DIR}/inner/attach-me.txt")
            return status(client.call("get_app_state", window="skfiy fixture"))
        case("file_dialog chooses a file in an Open panel", choose, re.escape(f"chosen {PANEL_DIR}/inner/attach-me.txt"))

        def save():
            open_panel("Save as…")
            client.call("file_dialog", path=f"{PANEL_DIR}/saved.txt")
            written = open(f"{PANEL_DIR}/saved.txt").read().strip() if os.path.exists(f"{PANEL_DIR}/saved.txt") else "nothing"
            return status(client.call("get_app_state", window="skfiy fixture")) + " | " + written
        case("file_dialog saves through a Save panel", save, re.escape(f"saved {PANEL_DIR}/saved.txt | saved by the fixture"))

        def refuse_then_replace():
            open_panel("Save as…")
            try:
                client.call("file_dialog", path=f"{PANEL_DIR}/saved.txt")
                refused = "not refused"
            except RuntimeError as error:
                refused = "refused" if "already exists" in str(error) else str(error)[:80]
            client.call("file_dialog", path=f"{PANEL_DIR}/saved.txt", overwrite=True)
            return refused + " | " + status(client.call("get_app_state", window="skfiy fixture"))
        case("file_dialog replaces only with overwrite", refuse_then_replace, r"^refused \| saved ")

        def save_document():
            answer = client.call("save_document", path=f"{PANEL_DIR}/via-menu.txt")
            written = open(f"{PANEL_DIR}/via-menu.txt").read().strip() if os.path.exists(f"{PANEL_DIR}/via-menu.txt") else "nothing"
            return answer.splitlines()[0][:60] + " | " + written
        case("save_document falls back to the app's Save panel", save_document, r"^Saved to .* \| saved by the fixture$")

        # Copying something that is not text goes through the app's Copy
        # command, with the user's clipboard lent for that moment.
        def rich_copy_paste():
            before = clipboard_fingerprint()
            client.call("press_key", key="cmd+c")
            client.call("press_key", key="cmd+v")
            after = clipboard_fingerprint()
            return status(client.call("get_app_state", window="skfiy fixture")) + (" | the user's clipboard is back" if after == before else " | the user's clipboard changed")
        case("non-text copy and paste lend the user's clipboard and put it back", rich_copy_paste, r"^pasted teal swatch \| the user's clipboard is back$")

        # Reading the user's clipboard needs their approval; nothing is read
        # here: one client cannot ask, the other declines.
        def read_clipboard():
            answers = []
            for asker in (client, Client(DECLINE)):
                try:
                    asker.call("read_clipboard", reason="smoke test")
                    answers.append("read")
                except RuntimeError as error:
                    answers.append("declined" if "declined" in str(error) else "cannot ask" if "cannot ask" in str(error)
                                   else "empty" if "clipboard is empty" in str(error) else str(error)[:60])
                if asker is not client:
                    answers.append(f"asked {len(asker.asked)}x")
                    asker.close()
            return " | ".join(answers)
        # With an empty clipboard there is nothing to ask about.
        case("read_clipboard only with the user's approval", read_clipboard, r"^(cannot ask \| declined \| asked 1x|empty \| empty \| asked 0x)$")

        # Handing a step to the user: nothing happens without them, and a
        # confirmation is checked against the app.
        def hand_over():
            answers = []
            for asker in (client, Client(DECLINE), Client(APPROVE)):
                try:
                    out = asker.call("hand_over", message="Sign in (smoke test)", app=APP, expect="skfiy fixture")
                    answers.append("done, checked" if out.startswith('The user says it is done. "skfiy fixture" appeared') else out[:60])
                except RuntimeError as error:
                    text = str(error)
                    answers.append("cannot ask" if "No answer came" in text else "declined" if "did not do it" in text else text[:60])
                if asker is not client:
                    asker.close()
            return " | ".join(answers)
        case("hand_over waits for the user and checks the app", hand_over, r"^cannot ask \| declined \| done, checked$")

        # Context menus never open in the background; run_in_front does it with
        # the user's approval.
        def right_click():
            now = client.call("get_app_state", window="skfiy fixture")
            try:
                client.call("click", element_index=index(now, r'Button "archive"'), mouse_button="right")
                return "opened"
            except RuntimeError as error:
                return "refused, pointing to run_in_front" if "run_in_front" in str(error) else str(error)[:80]
        case("a background right-click is refused and points to run_in_front", right_click, r"^refused, pointing to run_in_front$")

        def declined_menu():
            asker = Client(DECLINE)
            now = asker.call("get_app_state", window="skfiy fixture")
            try:
                asker.call("run_in_front", element_index=index(now, r'Button "archive"'), menu_item="Label > Red", reason="smoke test")
                answer = "ran"
            except RuntimeError as error:
                answer = "declined" if "declined" in str(error) else str(error)[:80]
            asker.close()
            return answer + " | " + status(client.call("get_app_state", window="skfiy fixture"))
        case("run_in_front with a context menu does nothing when declined", declined_menu, r"^declined \| (?!label)")

        if FRONT:
            def approved_menu():
                print("  … waiting until you have been idle for 10 s (not in Ghostty)")
                while idle_seconds() < 10 or "Ghostty" in frontmost() or APP in frontmost():
                    subprocess.run(["sleep", "1"])
                asker = Client(APPROVE)
                now = asker.call("get_app_state", window="skfiy fixture")
                user = frontmost()
                # Without this script's check: run_in_front brings the app forward by design.
                result = harness.Client.call(asker, "run_in_front", allow_error=True, app=APP, element_index=index(now, r'Button "archive"'),
                                             menu_item="Label > Red", reason="smoke test")
                back = frontmost() == user
                asker.close()
                if result["is_error"]:
                    return result["text"][:120]
                return status(client.call("get_app_state", window="skfiy fixture")) + (" | front app back" if back else f" | front app now {frontmost()}")
            case("run_in_front chooses from a context menu once approved", approved_menu, r"^label red chosen \| front app back$")

            def approved_click(name):
                def run():
                    while idle_seconds() < 10 or "Ghostty" in frontmost() or APP in frontmost():
                        subprocess.run(["sleep", "1"])
                    asker = Client(APPROVE)
                    x, y = green_half(asker, name)
                    user = frontmost()
                    result = harness.Client.call(asker, "run_in_front", allow_error=True, app=APP, x=x, y=y, reason="smoke test")
                    back = frontmost() == user
                    asker.close()
                    if result["is_error"]:
                        return result["text"][:120]
                    return status(client.call("get_app_state", window="skfiy fixture")) + (" | front app back" if back else f" | front app now {frontmost()}")
                return run
            case("run_in_front clicks a view that ignores background clicks", approved_click("strict canvas"), r"^strict canvas green clicked \| front app back$")
            case("run_in_front clicks a web view", approved_click("web canvas"), r"^web canvas green clicked \| front app back$")

        def hidden():
            open_panel("Choose file…")
            try:
                client.call("file_dialog", path="/tmp/skfiy-test/fixture.entitlements")
                answer = "not refused"
            except RuntimeError as error:
                answer = "refused: hidden" if "hidden" in str(error) else str(error)[:100]
            now = client.call("get_app_state")  # the panel is the focused window
            client.call("click", element_index=index(now, r'Button "Cancel"'))
            return answer
        case("file_dialog explains that hidden folders are out of reach", hidden, r"^refused: hidden$")

        # The action log keeps what was typed, except into password fields.
        def password_log():
            now = client.call("get_app_state", window="skfiy fixture")
            client.call("click", element_index=index(now, r"TextField\(SecureTextField\)"))
            client.call("type_text", text="hunter2")
            logged = open(ACTION_LOG).read()
            entry = [json.loads(line) for line in logged.splitlines() if '"type_text"' in line][-1]
            return ("secret leaked" if "hunter2" in logged else "no secret") + " | " + entry["arguments"]["text"]
        case("the action log records only the length of a password", password_log, r"^no secret \| \(7 characters, redacted\)$")

        # A window that publishes no accessibility: its text is recognized from
        # the pixels, positioned for click x/y, and wait_for matches it.
        def recognized_text():
            opaque = client.call("get_app_state", window="skfiy opaque")
            match = re.search(r'"发送消息" x=(\d+) y=(\d+)', opaque)
            if not match:
                return "not recognized: " + " | ".join(l for l in opaque.splitlines() if "recognized" in l or '" x=' in l)[:120]
            client.call("click", x=int(match.group(1)), y=int(match.group(2)))
            waited = client.call("wait_for", window="skfiy opaque", text="Cancel", timeout=5).splitlines()[0]
            return status(client.call("get_app_state", window="skfiy fixture")) + " | " + waited
        case("text in a window without accessibility is recognized and clicked", recognized_text,
             r'^text 发送消息 clicked \| "Cancel" appeared after')

        def click_canvas(name):
            def run():
                x, y = green_half(client, name)
                answer = client.call("click", x=x, y=y)
                return status(client.call("get_app_state", window="skfiy fixture")) + (" | points to focus" if "focus: true" in answer else "")
            return run
        case("background click on a custom-drawn canvas", click_canvas("canvas"), r"^canvas green clicked")
        # Views that refuse an inactive window's first click, and web views,
        # ignore it; the tool says so and points to focus and run_in_front.
        case("a view ignoring background clicks is reported, not faked", click_canvas("strict canvas"), r"^(?!strict).* \| points to focus$")

        def declined_focus():
            asker = Client(DECLINE)
            x, y = green_half(asker, "strict canvas")
            answer = asker.call("click", x=x, y=y, focus=True)
            asker.close()
            return ("declined noted" if "declined giving it focus" in answer else answer[:80]) + f" | asked {len(asker.asked)}x"
        case("click focus asks the user, and a decline is respected", declined_focus, r"^declined noted \| asked 1x$")

        client.call("press_key", key="cmd+q")
    finally:
        client.close()
        subprocess.run(["pkill", "-x", APP])
        subprocess.run(["rm", "-rf", PANEL_DIR])
        if os.path.exists(ACTION_LOG):
            os.remove(ACTION_LOG)
    front = frontmost()
    case("the fixture never came to the front", lambda: "never" if APP not in front else front, r"^never$")
    print(f"{sum(results)}/{len(results)} fixture checks passed")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
