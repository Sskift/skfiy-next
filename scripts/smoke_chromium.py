#!/usr/bin/env python3
"""Background web smoke test against scripts/fixtures/web.html in a Chromium browser.

Expects the fixture open in the browser (see `make smoke-web`). Every step
must leave the browser in the background; each capability is scored on its
own so one failure does not hide the rest.

    python3 scripts/smoke_chromium.py [path/to/skfiy] [app name]
"""
import json
import os
import re
import subprocess
import sys
import time

BINARY = sys.argv[1] if len(sys.argv) > 1 else ".build/debug/skfiy"
APP = sys.argv[2] if len(sys.argv) > 2 else "Google Chrome for Testing"
# Pointer clicks into web content need SKFIY_BRIEF_FOCUS=1 (Chromium drops
# pointer input to background windows); without it the tool must say so.
BRIEF_FOCUS = os.environ.get("SKFIY_BRIEF_FOCUS") == "1"


class Client:
    def __init__(self):
        self.proc = subprocess.Popen([BINARY, "mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.next_id = 0

    def request(self, method, params):
        self.next_id += 1
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()
        response = json.loads(self.proc.stdout.readline())
        if "error" in response:
            raise RuntimeError(response["error"])
        return response["result"]

    def call(self, tool, **arguments):
        result = self.request("tools/call", {"name": tool, "arguments": {"app": APP, **arguments}})
        text = result["content"][0]["text"]
        if result["isError"]:
            raise RuntimeError(f"{tool}: {text}")
        if APP in frontmost():
            raise AssertionError(f"{tool} brought {APP} to the front")
        return text


def frontmost():
    asn = subprocess.run(["lsappinfo", "front"], capture_output=True, text=True).stdout.strip()
    return subprocess.run(["lsappinfo", "info", "-only", "name", asn], capture_output=True, text=True).stdout


def index(tree, pattern):
    for line in tree.splitlines():
        if re.search(pattern, line):
            return re.search(r"\[(\d+)\]", line).group(1)
    raise AssertionError(f"no element matches {pattern!r}")


def status(client):
    tree = client.call("get_app_state")
    match = re.search(r'StaticText "status: ([^"]*)"', tree)
    return (match.group(1) if match else "?"), tree


results = []


def case(name, run, expect):
    try:
        observed = run()
        ok = re.search(expect, observed) is not None
        results.append((name, ok, observed))
    except Exception as error:  # noqa: BLE001 - scored, not raised
        results.append((name, False, f"error: {error}"))
    mark = "✔" if results[-1][1] else "✘"
    print(f"  {mark} {name}: {results[-1][2]}")


def main():
    client = Client()
    client.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "smoke", "version": "0"}})
    # Reload so every run starts from a fresh page (cmd+r is a menu shortcut,
    # disabled while the browser is in the background; the button works).
    for _ in range(20):  # a just-launched browser builds its tree lazily
        tree = client.call("get_app_state")
        if 'Button "Reload"' in tree and "WebArea" in tree:
            break
        time.sleep(0.5)
    client.call("click", element_index=index(tree, r'\] Button "Reload"'))
    time.sleep(1.5)
    _, tree = status(client)
    for _ in range(10):
        if "WebArea" in tree:
            break
        time.sleep(0.5)
        _, tree = status(client)

    def click_status(pattern, **extra):
        _, tree = status(client)
        client.call("click", element_index=index(tree, pattern), **extra)
        time.sleep(0.2)
        return status(client)[0]

    case("click link", lambda: click_status(r'\] Link "Go link"'), r"^link clicked$")
    case("click button", lambda: click_status(r'\] Button "Press me"'), r"^button clicked$")
    case("click checkbox", lambda: click_status(r'\] CheckBox "Agree"'), r"^checkbox true$")

    def type_into(pattern, text):
        _, tree = status(client)
        client.call("click", element_index=index(tree, pattern))
        client.call("type_text", text=text)
        time.sleep(0.2)
        return status(client)[0]

    case("type into input", lambda: type_into(r'\] TextField "Name"', "hello 你好"), r"^input hello 你好$")
    case("type into textarea", lambda: type_into(r'\] TextArea "Notes"', "notes"), r"^textarea notes$")

    def edit_contenteditable():
        _, tree = status(client)
        editor = index(tree, r'\] TextArea "Editor"')
        client.call("select_text", element_index=editor, text="me")
        client.call("type_text", text="you")
        time.sleep(0.2)
        return status(client)[0]

    case("select_text + type in contenteditable", edit_contenteditable, r"^editor edit you$")

    def set_input_value():
        _, tree = status(client)
        client.call("set_value", element_index=index(tree, r'\] TextField "Name"'), value="set directly")
        time.sleep(0.2)
        state, tree = status(client)
        return state + " | field: " + (re.search(r'TextField "Name" value="([^"]*)"', tree) or [None, "?"])[1]

    case("set_value on input", set_input_value, r"field: set directly")

    def key_on_page():
        _, tree = status(client)
        client.call("click", element_index=index(tree, r'\] Heading "skfiy web fixture"'))
        client.call("press_key", key="k")
        time.sleep(0.2)
        return status(client)[0]

    if BRIEF_FOCUS:
        case("press_key on the page", key_on_page, r"^key k$")
    else:
        print("  - press_key on the page: skipped (blurring a field with a pointer click needs SKFIY_BRIEF_FOCUS=1)")

    def scroll_region():
        _, tree = status(client)
        client.call("scroll", element_index=index(tree, r'Group\(LandmarkRegion\) "Scroller"'), direction="down", pages=0.5)
        time.sleep(0.3)
        return status(client)[0]

    case("scroll an overflow div", scroll_region, r"^scroll [1-9]")

    def click_canvas():
        _, tree = status(client)
        message = client.call("click", element_index=index(tree, r'"Canvas"')).splitlines()[0]
        time.sleep(0.2)
        return status(client)[0] if BRIEF_FOCUS else message

    case("pointer click on a canvas", click_canvas,
         r"^canvas (green|orange)$" if BRIEF_FOCUS else r"Chromium ignores pointer input")

    def choose_option():
        _, tree = status(client)
        client.call("set_value", element_index=index(tree, r'\] PopUpButton "Fruit"'), value="cherry")
        time.sleep(0.2)
        return status(client)[0]

    case("choose a select option", choose_option, r"^select cherry$")

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"{passed}/{len(results)} web capabilities work in the background")
    client.proc.stdin.close()
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
