#!/usr/bin/env python3
"""End-to-end smoke test: drives TextEdit through the real MCP server.

Everything must happen in the background: TextEdit must never become the
frontmost app, so whatever the user is doing keeps the focus. TextEdit must not be
running (so no real documents are touched); it is quit without saving.

    swift build && python3 scripts/smoke_textedit.py [path/to/skfiy]
"""
import json
import os
import re
import subprocess
import sys
import threading
import time

BINARY = sys.argv[1] if len(sys.argv) > 1 else ".build/debug/skfiy"
# This test's own emergency-stop flag, so stopping it never stops the user's skfiy.
STOP_ENV = {**os.environ, "SKFIY_STOP_FILE": f"/tmp/skfiy-smoke-stop-{os.getpid()}"}
# And its own action log, never the user's.
ACTION_LOG = f"/tmp/skfiy-smoke-actions-{os.getpid()}.jsonl"
STOP_ENV["SKFIY_ACTION_LOG"] = ACTION_LOG
APP = "TextEdit"


class Client:
    def __init__(self, binary):
        self.proc = subprocess.Popen(
            [binary, "mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1, env=STOP_ENV
        )
        self.next_id = 0

    def request(self, method, params=None):
        self.next_id += 1
        message = {"jsonrpc": "2.0", "id": self.next_id, "method": method}
        if params is not None:
            message["params"] = params
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("server exited")
        response = json.loads(line)
        assert response["id"] == self.next_id, response
        if "error" in response:
            raise RuntimeError(response["error"])
        return response["result"]

    def notify(self, method):
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method}) + "\n")
        self.proc.stdin.flush()

    def call(self, tool, expect_error=False, **arguments):
        before = frontmost()
        started = time.time()
        result = self.request("tools/call", {"name": tool, "arguments": {"app": APP, **arguments}})
        text = result["content"][0]["text"]
        images = [c for c in result["content"] if c["type"] == "image"]
        elapsed = time.time() - started
        status = "error" if result["isError"] else "ok"
        print(f"  {tool}({', '.join(f'{k}={v!r}' for k, v in arguments.items())}) -> {status} in {elapsed:.2f}s, {len(images)} image(s)")
        if "TextEdit" not in before and "TextEdit" in frontmost():
            raise AssertionError(f"{tool} brought TextEdit to the front")
        if result["isError"] != expect_error:
            raise AssertionError(f"{tool} returned isError={result['isError']}: {text}")
        return text

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=5)


def find(tree, pattern):
    """Index of the first tree line matching `pattern`."""
    for line in tree.splitlines():
        if re.search(pattern, line):
            match = re.search(r"\[(\d+)\]", line)
            if match:
                return match.group(1)
    raise AssertionError(f"no line matches {pattern!r} in:\n{tree}")


def text_value(tree):
    for line in tree.splitlines():
        if re.search(r"\] TextArea", line):
            match = re.search(r'value="((?:[^"\\]|\\.)*)"', line)
            return json.loads('"' + match.group(1) + '"') if match else ""
    raise AssertionError("no TextArea in tree")


def vscroll(tree):
    for line in tree.splitlines():
        if "ScrollArea" in line and "vscroll=" in line:
            return int(re.search(r"vscroll=(\d+)%", line).group(1))
    raise AssertionError("no scroll position in tree")


def frontmost():
    asn = subprocess.run(["lsappinfo", "front"], capture_output=True, text=True).stdout.strip()
    info = subprocess.run(["lsappinfo", "info", "-only", "name", asn], capture_output=True, text=True).stdout
    return info.strip()


def pasteboard_change_count():
    # Only the change counter, never the clipboard's content.
    script = 'ObjC.import("AppKit"); $.NSPasteboard.generalPasteboard.changeCount'
    return subprocess.run(["osascript", "-l", "JavaScript", "-e", script], capture_output=True, text=True).stdout.strip()


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print(f"    ✔ {message}")


def main():
    running = subprocess.run(["pgrep", "-x", APP], capture_output=True).returncode == 0
    if running:
        sys.exit("TextEdit is running; quit it first so no real document is touched.")

    print(f"frontmost app at start: {frontmost()}")
    client = Client(BINARY)
    try:
        info = client.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "smoke", "version": "0"}})
        client.notify("notifications/initialized")
        tools = [t["name"] for t in client.request("tools/list")["tools"]]
        core = {"list_apps", "get_app_state", "click", "perform_secondary_action", "set_value",
                "select_text", "scroll", "drag", "press_key", "type_text"}
        check(info["serverInfo"]["name"] == "skfiy" and core <= set(tools), f"initialize + {len(tools)} tools")

        state = client.call("get_app_state")
        check("App: TextEdit" in state, "get_app_state launched TextEdit")
        # A fresh launch may show the open panel; a new document is what we want.
        client.call("press_key", key="cmd+n")
        state = client.call("get_app_state")
        area = find(state, r"\] TextArea")

        client.call("click", element_index=area)
        sample = "Hello skfiy\n你好，世界 🌍"
        client.call("type_text", text=sample)
        state = client.call("get_app_state")
        check(text_value(state) == sample, f"type_text wrote {sample!r}")

        # find keeps a large tree short; its indices are those of the full tree.
        found = client.call("get_app_state", find="TextArea")
        body = found.split("\n\n", 1)[1]
        check("Showing the 1 line(s)" in found and "TextArea" in body and "Menu bar" not in body,
              "get_app_state find listed only the text area")
        # zoom reads part of the screenshot at the display's resolution.
        zoomed = client.call("zoom", x=0, y=0, width=200, height=100)
        match = re.search(r"px, ([\d.]+)× its detail", zoomed)
        check(match is not None, f"zoom answered: {zoomed.splitlines()[0][:100]}")
        detail = float(match.group(1))
        check(detail >= 1, f"zoom returned the region at {detail}× the screenshot's detail")

        area = find(found, r"\] TextArea")
        client.call("select_text", element_index=area, text="skfiy")
        client.call("type_text", text="world")
        state = client.call("get_app_state")
        check(text_value(state).startswith("Hello world\n"), "select_text + type_text replaced the selection")

        area = find(state, r"\] TextArea")
        client.call("select_text", element_index=area, text="Hello", selection="cursor_after")
        client.call("press_key", key="comma")
        state = client.call("get_app_state")
        check(text_value(state).startswith("Hello, world"), "cursor_after + press_key inserted a comma")

        # Copy and paste go through skfiy's own clipboard; the user's is never touched.
        clipboard_before = pasteboard_change_count()
        area = find(state, r"\] TextArea")
        client.call("select_text", element_index=area, text="Hello")
        client.call("press_key", key="cmd+c")
        client.call("select_text", element_index=area, text="world", selection="cursor_after")
        client.call("type_text", text=" ")
        client.call("press_key", key="cmd+v")
        state = client.call("get_app_state")
        check(text_value(state).startswith("Hello, world Hello"), "cmd+c, cmd+v copied and pasted text")
        check(pasteboard_change_count() == clipboard_before, "the user's clipboard was not touched")

        # Emergency stop: calls are refused until resumed, and typing breaks off.
        stop = lambda verb: subprocess.run([BINARY, verb], env=STOP_ENV, capture_output=True)
        stop("stop")
        client.call("get_app_state", expect_error=True)
        stop("resume")
        state = client.call("get_app_state")
        check("App: TextEdit" in state, "skfiy stop refused calls until skfiy resume")
        area = find(state, r"\] TextArea")
        client.call("select_text", element_index=area, text="Hello, world", selection="cursor_before")
        threading.Timer(0.25, stop, args=("stop",)).start()
        client.call("type_text", text="z" * 180, expect_error=True)
        stop("resume")
        state = client.call("get_app_state")
        typed = len(text_value(state)) - len(text_value(state).lstrip("z"))
        check(0 < typed < 180, f"the emergency stop broke off typing after {typed} of 180 characters")

        # wait_for: a text another process puts there a second later.
        script = 'tell application "TextEdit" to set text of document 1 to "ready now"'
        threading.Timer(1.0, subprocess.run, args=(["osascript", "-e", script],), kwargs={"capture_output": True}).start()
        started = time.time()
        waited = client.call("wait_for", text="Ready now", timeout=8)
        check(waited.startswith('"ready now" appeared after') and time.time() - started >= 0.8,
              f"wait_for saw the text appear after {time.time() - started:.1f} s")
        client.call("wait_for", text="ready now", gone=True, timeout=1, expect_error=True)
        check(True, "wait_for timed out while the text stayed")
        waited = client.call("wait_for")
        check(waited.startswith("The window stopped changing"), "wait_for without a text returned once the window was still")

        state = client.call("get_app_state")
        area = find(state, r"\] TextArea")
        client.call("set_value", element_index=area, value="set by accessibility")
        state = client.call("get_app_state")
        check(text_value(state) == "set by accessibility", "set_value replaced the text")

        client.call("press_key", key="cmd+a")
        client.call("press_key", key="BackSpace")
        state = client.call("get_app_state")
        check(text_value(state) == "", "cmd+a, BackSpace cleared the document")

        long_text = "\n".join(f"line {n}" for n in range(1, 121))
        client.call("type_text", text=long_text)
        client.call("press_key", key="cmd+Up")
        state = client.call("get_app_state")
        top = vscroll(state)
        scroll_area = find(state, r"\] ScrollArea")
        client.call("scroll", element_index=scroll_area, direction="down", pages=1.5)
        state = client.call("get_app_state")
        after_down = vscroll(state)
        check(after_down > top, f"wheel scroll down moved {top}% -> {after_down}%")
        client.call("scroll", element_index=scroll_area, direction="up", pages=1)
        state = client.call("get_app_state")
        check(vscroll(state) < after_down, f"wheel scroll up moved {after_down}% -> {vscroll(state)}%")

        # A pixel click in the text area moves the caret (hit-tested through
        # accessibility): park the caret at the start, click below the text,
        # and the typed character must land at the end.
        area = find(state, r"\] TextArea")
        client.call("set_value", element_index=area, value="alpha\nbeta\ngamma")
        client.call("select_text", element_index=area, text="alpha", selection="cursor_before")
        # Screen capture occasionally stalls system-wide for up to a minute;
        # the tree still comes back meanwhile. This step needs pixels.
        waited = time.time()
        for _ in range(20):
            state = client.call("get_app_state")
            shot = re.search(r"Screenshot: \d+×(\d+) px", state)
            if shot:
                break
            time.sleep(3)
        stalled = f" (screen capture recovered after {time.time() - waited:.0f} s)" if time.time() - waited > 5 else ""
        check(shot is not None, "get_app_state returned a screenshot" + (stalled or ": " + " | ".join(state.splitlines()[:4])[:120]))
        height = int(shot.group(1))
        client.call("click", x=40, y=height - 40)
        client.call("type_text", text="X")
        state = client.call("get_app_state")
        check(text_value(state) == "alpha\nbeta\ngammaX", f"pixel click moved the caret: {text_value(state)!r}")

        # Saving to a path goes through Apple Events, never a Save panel.
        saved = f"/tmp/skfiy-smoke-{os.getpid()}.rtf"
        client.call("save_document", path=saved)
        written = open(saved, errors="replace").read() if os.path.exists(saved) else ""
        check("gammaX" in written, f"save_document wrote {saved}")
        client.call("save_document", path=saved, expect_error=True)
        check(os.path.getsize(saved) == len(written.encode()), "save_document refused to overwrite without overwrite: true")

        client.call("click", x=5000, y=5000, expect_error=True)
        client.call("click", element_index="99999", expect_error=True)
        client.call("press_key", key="hyper+q", expect_error=True)

        # The document is saved now, so closing it asks nothing.
        client.call("press_key", key="cmd+w")
        client.call("press_key", key="cmd+q")
        for _ in range(25):  # a saved document may take a moment to close
            gone = subprocess.run(["pgrep", "-x", APP], capture_output=True).returncode != 0
            if gone:
                break
            time.sleep(0.2)
        os.remove(saved)
        check(gone, "closed the saved document and quit TextEdit")
        check("TextEdit" not in frontmost(), f"TextEdit never came to the front (front app now: {frontmost()})")
        logged = [json.loads(line) for line in open(ACTION_LOG)] if os.path.exists(ACTION_LOG) else []
        tools = {entry["tool"] for entry in logged}
        check(any(entry["tool"] == "type_text" and entry["arguments"].get("text") == sample for entry in logged)
              and "get_app_state" not in tools and "save_document" in tools,
              f"the action log recorded {len(logged)} actions (typing, saving), not the looks")
        os.remove(ACTION_LOG)
        print("PASS")
    finally:
        client.close()
        # Only test documents are open (TextEdit was not running at the start).
        # Quitting without saving keeps a failed run from leaving windows that
        # TextEdit would restore next time.
        if subprocess.run(["pgrep", "-x", APP], capture_output=True).returncode == 0:
            subprocess.run(["osascript", "-e", 'tell application "TextEdit" to quit saving no'], capture_output=True)


if __name__ == "__main__":
    main()
