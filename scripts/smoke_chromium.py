#!/usr/bin/env python3
"""Background web smoke test against scripts/fixtures/web.html in a browser
(Chromium or Safari) through the app tools.

Expects the fixture open in the browser (see `make smoke-web`). Every step
must leave the browser in the background; each capability is scored on its
own so one failure does not hide the rest.

    python3 scripts/smoke_chromium.py [path/to/skfiy] [app name]
"""
import os
from pathlib import Path
import re
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import harness  # noqa: E402
from harness import case, frontmost, index, results, status  # noqa: E402

BINARY = sys.argv[1] if len(sys.argv) > 1 else ".build/debug/skfiy"
APP = sys.argv[2] if len(sys.argv) > 2 else "Google Chrome for Testing"
# Pointer clicks into web content need SKFIY_BRIEF_FOCUS=1 (Chromium and
# WebKit drop pointer input to background windows); without it the tool must say so.
RELOAD = r'\] Button "Reload( this page)?"'
POINTER = os.environ.get("SKFIY_BRIEF_FOCUS") == "1"


class Client(harness.Client):
    def call(self, tool, **arguments):
        before = frontmost()
        text = super().call(tool, app=APP, **arguments)["text"]
        # Only a switch that happened during this call is the call's doing.
        if APP not in before and APP in frontmost():
            raise AssertionError(f"{tool} brought {APP} to the front")
        return text


def page(client):
    tree = client.call("get_app_state")
    return status(tree), tree


def main():
    client = Client(BINARY)
    # Reload so every run starts from a fresh page (cmd+r is a menu shortcut,
    # disabled while the browser is in the background; the button works).
    for _ in range(20):  # a just-launched browser builds its tree lazily
        tree = client.call("get_app_state")
        if re.search(RELOAD, tree) and "WebArea" in tree:
            break
        time.sleep(0.5)
    client.call("click", element_index=index(tree, RELOAD))
    time.sleep(1.5)
    _, tree = page(client)
    for _ in range(10):
        if "WebArea" in tree:
            break
        time.sleep(0.5)
        _, tree = page(client)

    def click_status(pattern, **extra):
        _, tree = page(client)
        client.call("click", element_index=index(tree, pattern), **extra)
        time.sleep(0.2)
        return page(client)[0]

    case("click link", lambda: click_status(r'\] Link "Go link"'), r"^link clicked$")
    case("click button", lambda: click_status(r'\] Button "Press me"'), r"^button clicked$")
    case("click checkbox", lambda: click_status(r'\] CheckBox "Agree"'), r"^checkbox true$")

    def type_into(pattern, text):
        _, tree = page(client)
        client.call("click", element_index=index(tree, pattern))
        client.call("type_text", text=text)
        time.sleep(0.2)
        return page(client)[0]

    case("type into input", lambda: type_into(r'\] TextField "Name"', "hello 你好"), r"^input hello 你好$")
    case("type into textarea", lambda: type_into(r'\] TextArea "Notes"', "notes"), r"^textarea notes$")

    def edit_contenteditable():
        _, tree = page(client)
        editor = index(tree, r'\] TextArea "Editor"')
        client.call("select_text", element_index=editor, text="me")
        client.call("type_text", text="you")
        time.sleep(0.2)
        return page(client)[0]

    case("select_text + type in contenteditable", edit_contenteditable, r"^editor edit you$")

    def set_input_value():
        _, tree = page(client)
        client.call("set_value", element_index=index(tree, r'\] TextField "Name"'), value="set directly")
        time.sleep(0.2)
        state, tree = page(client)
        return state + " | field: " + (re.search(r'TextField "Name" value="([^"]*)"', tree) or [None, "?"])[1]

    case("set_value on input", set_input_value, r"field: set directly")

    def key_on_page():
        _, tree = page(client)
        client.call("click", element_index=index(tree, r'\] Heading "skfiy web fixture"'))
        client.call("press_key", key="k")
        time.sleep(0.2)
        return page(client)[0]

    if POINTER:
        case("press_key on the page", key_on_page, r"^key k$")
    else:
        print("  - press_key on the page: skipped (blurring a field with a pointer click needs SKFIY_BRIEF_FOCUS=1)")

    def hold_key():
        _, tree = page(client)
        client.call("click", element_index=index(tree, r'\] TextField "Name"'))
        client.call("press_key", key="x", hold_seconds=0.8)
        time.sleep(0.2)
        return page(client)[0]

    case("hold a key", hold_key, r"^held x 0\.[789]s$")

    def scroll_region():
        _, tree = page(client)
        client.call("scroll", element_index=index(tree, r'Group\(LandmarkRegion\) "Scroller"'), direction="down", pages=0.5)
        time.sleep(0.3)
        return page(client)[0]

    case("scroll an overflow div", scroll_region, r"^scroll [1-9]")

    def click_canvas():
        _, tree = page(client)
        message = client.call("click", element_index=index(tree, r'"Canvas"')).splitlines()[0]
        time.sleep(0.2)
        return page(client)[0] if POINTER else message

    case("pointer click on a canvas", click_canvas,
         r"^canvas (green|orange)$" if POINTER else r"ignores pointer input in background windows")

    def choose_option():
        _, tree = page(client)
        client.call("set_value", element_index=index(tree, r'\] PopUpButton "Fruit"'), value="cherry")
        time.sleep(0.2)
        return page(client)[0]

    case("choose a select option", choose_option, r"^select cherry$")

    print(f"{sum(results)}/{len(results)} web capabilities work in the background")
    client.close()
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
