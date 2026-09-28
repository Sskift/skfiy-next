#!/usr/bin/env python3
"""Read-only coverage probe: runs get_app_state on apps that are already
running and reports only numbers (tree size, element count, roles, timing,
whether a screenshot came back). No tree text, titles or pixels are printed,
and nothing is clicked or typed. Fails if any call changes the front app.

    python3 scripts/app_coverage.py [path/to/skfiy] [app ...]
"""
import collections
import json
import re
import subprocess
import sys
import time

BINARY = sys.argv[1] if len(sys.argv) > 1 else ".build/debug/skfiy"
ONLY = sys.argv[2:]
SKIP = {"Ghostty", "Google Chrome for Testing"}  # the user's terminal; the test browser
WEB_ROLES = {"WebArea"}
ACTIONABLE = {"Button", "Link", "TextField", "TextArea", "CheckBox", "RadioButton", "PopUpButton",
              "ComboBox", "MenuButton", "Slider", "Row", "Cell", "Tab", "MenuBarItem", "MenuItem",
              "Incrementor", "DisclosureTriangle", "SearchField"}


class Client:
    def __init__(self):
        self.proc = subprocess.Popen([BINARY, "mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.next_id = 0
        self.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "coverage", "version": "0"}})

    def request(self, method, params):
        self.next_id += 1
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()
        return json.loads(self.proc.stdout.readline())["result"]

    def call(self, tool, **arguments):
        return self.request("tools/call", {"name": tool, "arguments": arguments})


def frontmost():
    asn = subprocess.run(["lsappinfo", "front"], capture_output=True, text=True).stdout.strip()
    return subprocess.run(["lsappinfo", "info", "-only", "name", asn], capture_output=True, text=True).stdout.strip()


def running_apps(client):
    text = client.call("list_apps")["content"][0]["text"]
    section = text.split("\n\n")[0]
    return [m.group(1) for m in re.finditer(r"^- (.+?) — ", section, re.M)]


def measure(client, app):
    before = frontmost()
    started = time.time()
    result = client.call("get_app_state", app=app)
    elapsed = time.time() - started
    stole = before != frontmost() and app in frontmost()
    text = result["content"][0]["text"]
    if result.get("isError"):
        # Our own error message, not app content.
        return {"error": text.splitlines()[0][:120], "seconds": elapsed, "stole_front": stole}
    element_lines = re.findall(r"^\s*\[(\d+)\] (\w+)", text, re.M)
    roles = collections.Counter(role for _, role in element_lines)
    return {
        "seconds": elapsed,
        "stole_front": stole,
        "lines": text.count("\n") + 1,
        "elements": len(element_lines),
        "actionable": sum(count for role, count in roles.items() if role in ACTIONABLE),
        "web": any(role in WEB_ROLES for role in roles),
        "screenshot": any(block.get("type") == "image" for block in result["content"]),
        "focus": "Keyboard focus:" in text,
        "top_roles": ", ".join(f"{role}×{count}" for role, count in roles.most_common(4)),
    }


def main():
    client = Client()
    apps = ONLY or [app for app in running_apps(client) if app not in SKIP]
    print(f"{'app':<20} {'1st s':>6} {'2nd s':>6} {'elems':>6} {'act':>5} {'lines':>6} shot web focus  top roles")
    stolen = []
    for app in apps:
        first = measure(client, app)
        if "error" in first:
            print(f"{app:<20} {first['seconds']:6.2f}  error: {first['error']}")
            continue
        second = measure(client, app)  # accessibility already enabled, caches warm
        if first["stole_front"] or second.get("stole_front"):
            stolen.append(app)
        print(f"{app:<20} {first['seconds']:6.2f} {second['seconds']:6.2f} {first['elements']:6d} {first['actionable']:5d} "
              f"{first['lines']:6d} {'yes' if first['screenshot'] else 'no':>4} {'yes' if first['web'] else '-':>3} "
              f"{'yes' if first['focus'] else '-':>5}  {first['top_roles']}")
    client.proc.stdin.close()
    if stolen:
        print(f"FAIL: front app changed during get_app_state for {', '.join(stolen)}")
        sys.exit(1)
    print(f"front app never taken ({len(apps)} apps probed)")


if __name__ == "__main__":
    main()
