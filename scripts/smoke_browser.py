#!/usr/bin/env python3
"""Browser bridge smoke test: drives scripts/fixtures/web.html in a new
background tab through the skfiy extension.

Needs a Chromium browser with the extension loaded and the fixture served at
FIXTURE_URL (see `make smoke-browser`). Asserts that the tab the user is
looking at never changes and the browser never comes to the front.

With --user-browser it runs against your own browser: only in its own
background tab, without the debugger (which shows an infobar) and without
touching the tab you are looking at.

    python3 scripts/smoke_browser.py [path/to/skfiy] [--user-browser]
"""
import json
import os
import re
import subprocess
import sys

USER_BROWSER = "--user-browser" in sys.argv
ARGS = [arg for arg in sys.argv[1:] if arg != "--user-browser"]
BINARY = ARGS[0] if ARGS else ".build/debug/skfiy"
BROWSER_APP = "Google Chrome" if USER_BROWSER else "Chrome for Testing"
BROWSER_NAME = "Google Chrome" if USER_BROWSER else "Chromium"  # as the extension reports itself
FIXTURE_URL = "http://127.0.0.1:8765/web.html"
CAME_TO_FRONT = False


class Client:
    def __init__(self):
        self.proc = subprocess.Popen([BINARY, "mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.next_id = 0
        self.asked = []  # approvals the server asked for (answered yes)
        self.send({"jsonrpc": "2.0", "id": 0, "method": "initialize",
                   "params": {"protocolVersion": "2025-11-25", "capabilities": {"elicitation": {"form": {}}}}})
        self.read(0)

    def send(self, message):
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def read(self, wanted):
        while True:
            message = json.loads(self.proc.stdout.readline())
            if message.get("method") == "elicitation/create":
                self.asked.append(message["params"]["message"])
                self.send({"jsonrpc": "2.0", "id": message["id"], "result": {"action": "accept", "content": {"allow": True}}})
            elif message.get("id") == wanted:
                return message

    def call(self, tool, **arguments):
        global CAME_TO_FRONT
        before = frontmost()
        self.next_id += 1
        arguments = {"browser": BROWSER_NAME, **arguments}  # other browsers may be connected too
        self.send({"jsonrpc": "2.0", "id": self.next_id, "method": "tools/call", "params": {"name": tool, "arguments": arguments}})
        result = self.read(self.next_id)["result"]
        text = result["content"][0]["text"]
        if not is_browser(before) and is_browser(frontmost()):
            CAME_TO_FRONT = True
        if result["isError"]:
            raise RuntimeError(f"{tool}: {text}")
        return text


def front_tabs(text):
    return sorted(re.findall(r"tab (\d+) \[(?:shown|front tab of its window)\]", text))


def index(tree, pattern):
    match = re.search(r"\[(\d+)\] " + pattern, tree)
    if not match:
        raise AssertionError(f"no element matches {pattern!r} in:\n{tree}")
    return int(match.group(1))


def status(text):
    match = re.search(r"^status: (.*)$", text, re.M)
    return match.group(1) if match else "?"


results = []


def case(name, run, expect):
    try:
        observed = run()
        ok = re.search(expect, observed) is not None
    except Exception as error:  # noqa: BLE001 - scored, not raised
        observed = f"error: {error}"
        ok = re.search(expect, observed) is not None
    results.append(ok)
    print(f"  {'✔' if ok else '✘'} {name}: {observed}")


def is_browser(front):
    # "Google Chrome" must not match "Google Chrome for Testing" and vice versa.
    return re.search(re.escape(BROWSER_APP) + (r'"' if USER_BROWSER else ""), front) is not None


def frontmost():
    asn = subprocess.run(["lsappinfo", "front"], capture_output=True, text=True).stdout.strip()
    return subprocess.run(["lsappinfo", "info", "-only", "name", asn], capture_output=True, text=True).stdout


def main():
    client = Client()
    before = client.call("browser_tabs")
    if not USER_BROWSER:
        print(before)  # the user's own tab titles stay private
    shown_before = front_tabs(before)

    opened = client.call("browser_open", url=FIXTURE_URL)
    tab = int(re.search(r"background tab (\d+)", opened).group(1))
    tree = client.call("browser_state", tab_id=tab)

    def act(tool, **arguments):
        return status(client.call(tool, tab_id=tab, **arguments))

    case("click link", lambda: act("browser_click", index=index(tree, r'link "Go link"')), r"^link clicked")
    case("click button", lambda: act("browser_click", index=index(tree, r'button "Press me"')), r"^button clicked")
    if not USER_BROWSER:
        case("trusted click refused on a background tab", lambda: act("browser_click", index=index(tree, r'button "Press me"'), trusted=True), r"only reach the tab shown")
    case("click checkbox", lambda: act("browser_click", index=index(tree, r'checkbox "Agree"')), r"^checkbox true$")
    case("select option", lambda: act("browser_select", index=index(tree, r'select "Fruit"'), option="cherry"), r"^select cherry")
    name = index(tree, r'text "Name"')
    case("type into input (CJK)", lambda: act("browser_type", index=name, text="hello 你好"), r"^input hello 你好$")
    case("press a character key", lambda: act("browser_press_key", index=name, key="k"), r"^input hello 你好k$")
    case("press Backspace", lambda: act("browser_press_key", index=name, key="BackSpace"), r"^input hello 你好$")
    case("replace with clear", lambda: act("browser_type", index=name, text="fresh", clear=True), r"^input fresh$")
    case("type into textarea", lambda: act("browser_type", index=index(tree, r'textarea "Notes"'), text="notes"), r"^textarea notes$")
    case("type into contenteditable", lambda: act("browser_type", index=index(tree, r'\w+ "Editor"'), text="!!"), r"^editor edit me!!$")
    case("type and submit a form", lambda: act("browser_type", index=index(tree, r'text "Query"'), text="skfiy", submit=True), r"^submitted skfiy$")
    def scroll_element():
        text = client.call("browser_scroll", tab_id=tab, index=index(tree, r'region "Scroller"'), direction="down", pages=0.5)
        return re.search(r'region "Scroller"[^\n]*', text).group(0)

    case("scroll an element", scroll_element, r"scroll=[1-9]\d*/")

    # Frames: the same-origin one is read inline, the cross-origin one after it.
    frames = client.call("browser_state", tab_id=tab)
    buttons = [int(n) for n in re.findall(r'\[(\d+)\] button "Frame button"', frames)]
    fields = [int(n) for n in re.findall(r'\[(\d+)\] text "Frame field"', frames)]
    case("both frames listed", lambda: f"{len(buttons)} frame buttons, {len(fields)} frame fields", r"^2 frame buttons, 2 frame fields$")
    case("click in a same-origin frame", lambda: act("browser_click", index=buttons[0]), r"^frame clicked \(127\.0\.0\.1\)$")
    case("click in a cross-origin frame", lambda: act("browser_click", index=buttons[1]), r"^frame clicked \(localhost\)$")
    case("type in a cross-origin frame", lambda: act("browser_type", index=fields[1], text="hi"), r"^frame typed hi \(localhost\)$")

    # Page dialogs in the agent's own tab answer at once instead of blocking.
    page = client.call("browser_state", tab_id=tab)
    def alert():
        # The click returns the page state, which reports (and clears) the dialog.
        text = client.call("browser_click", tab_id=tab, index=index(page, r'button "Alert me"'))
        return status(text) + " | " + (re.search(r"\(page dialog\)[^\n]*", text) or re.search("$", "")).group(0)
    case("alert does not block the page", alert, r'^alerted( untrusted)? \| \(page dialog\) alert "Saved!"')
    case("confirm answered with dismiss", lambda: act("browser_click", index=index(page, r'button "Confirm me"'), dialog="dismiss"), r"^confirm false( untrusted)?$")
    case("prompt answered with text", lambda: act("browser_click", index=index(page, r'button "Prompt me"'), prompt_text="skfiy"), r"^prompt skfiy( untrusted)?$")

    # Uploads send a local file to the site, so the user is asked first.
    upload = f"/tmp/skfiy-upload-{os.getpid()}.txt"
    open(upload, "w").write("hello upload\n")
    asked_before = len(client.asked)
    def attach():
        result = act("browser_upload", index=index(page, r'file "Attachment"'), path=upload)
        return result + f" | asked={len(client.asked) - asked_before}"
    case("upload a file after approval", attach, rf"^file skfiy-upload-\d+\.txt 13 bytes: hello upload( untrusted)? \| asked=1$")
    os.remove(upload)
    def trusted_typing():
        text = client.call("browser_type", tab_id=tab, index=name, text=" ok", trusted=True)
        return re.search(r'text "Name"[^\n]*', text).group(0)

    if not USER_BROWSER:
        case("trusted typing (debugger)", trusted_typing, r'value="fresh ok"')

        # Trusted clicks and keys need a visible tab. This is the test browser, so
        # its own front tab (showing the same fixture) may be used for them.
        shown = int(front_tabs(before)[0])
        shown_tree = client.call("browser_state", tab_id=shown, screenshot=False)

        def on_shown(tool, **arguments):
            return status(client.call(tool, tab_id=shown, **arguments))

        case("trusted click on a visible tab", lambda: on_shown("browser_click", index=index(shown_tree, r'button "Press me"'), trusted=True), r"^button clicked$")
        shown_name = index(shown_tree, r'text "Name"')
        on_shown("browser_type", index=shown_name, text="abc", clear=True)
        case("trusted key on a visible tab", lambda: on_shown("browser_press_key", index=shown_name, key="BackSpace", trusted=True), r"^input ab$")
    case("reload", lambda: act("browser_navigate", action="reload"), r"^ready$")

    after = client.call("browser_tabs")
    shown_after = front_tabs(after)
    case("user's visible tabs unchanged", lambda: f"{shown_before} -> {shown_after}", r".*" if shown_before == shown_after else r"^$")
    client.call("browser_close_tab", tab_id=tab)
    case("browser never came to the front", lambda: "never" if not CAME_TO_FRONT else "came to the front", r"^never$")

    print(f"{sum(results)}/{len(results)} browser checks passed")
    client.proc.stdin.close()
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
