#!/usr/bin/env python3
"""Read-only coverage probe: runs get_app_state on apps that are already
running and reports only numbers (tree size, element count, roles, timing,
whether a screenshot came back). No tree text, titles or pixels are printed,
and nothing is clicked or typed. Fails if any call changes the front app.

    python3 scripts/app_coverage.py [path/to/skfiy] [app ...]
"""
import collections
from pathlib import Path
import re
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness import Client, frontmost  # noqa: E402

BINARY = sys.argv[1] if len(sys.argv) > 1 else ".build/debug/skfiy"
ONLY = sys.argv[2:]
SKIP = {"Ghostty", "Google Chrome for Testing"}  # the user's terminal; the test browser
WEB_ROLES = {"WebArea"}
ACTIONABLE = {"Button", "Link", "TextField", "TextArea", "CheckBox", "RadioButton", "PopUpButton",
              "ComboBox", "MenuButton", "Slider", "Row", "Cell", "Tab", "MenuBarItem", "MenuItem",
              "Incrementor", "DisclosureTriangle", "SearchField"}


def running_apps(client):
    text = client.call("list_apps")["text"]
    section = text.split("\n\n")[0]
    return [m.group(1) for m in re.finditer(r"^- (.+?) — ", section, re.M)]


def measure(client, app):
    before = frontmost()
    started = time.time()
    result = client.call("get_app_state", allow_error=True, app=app)
    elapsed = time.time() - started
    stole = before != frontmost() and app in frontmost()
    text = result["text"]
    if result["is_error"]:
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
        "screenshot": bool(result["images"]),
        "focus": "Keyboard focus:" in text,
        "top_roles": ", ".join(f"{role}×{count}" for role, count in roles.most_common(4)),
    }


def main():
    client = Client(BINARY, name="skfiy-coverage")
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
    client.close()
    if stolen:
        print(f"FAIL: front app changed during get_app_state for {', '.join(stolen)}")
        sys.exit(1)
    print(f"front app never taken ({len(apps)} apps probed)")


if __name__ == "__main__":
    main()
