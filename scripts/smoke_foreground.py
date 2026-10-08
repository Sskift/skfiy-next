#!/usr/bin/env python3
"""run_in_front smoke test: the one tool that brings an app forward.

Declined and unsupported approvals must change nothing. With --accept it also
brings TextEdit forward once, to make a word bold, after waiting until you
have been away from the keyboard and mouse for 10 s, and then checks that your
front app came back. TextEdit must not be running.

    python3 scripts/smoke_foreground.py [path/to/skfiy] [--accept]
"""
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import harness  # noqa: E402
from harness import APPROVE, DECLINE, frontmost  # noqa: E402
from scenario import idle_seconds  # noqa: E402

ARGS = [arg for arg in sys.argv[1:] if not arg.startswith("--")]
BINARY = ARGS[0] if ARGS else ".build/debug/skfiy"
ACCEPT = "--accept" in sys.argv


class Client(harness.Client):
    def __init__(self, answer=None):
        super().__init__(BINARY, answer=answer)

    def call(self, tool, **arguments):
        result = super().call(tool, allow_error=True, **{"app": "TextEdit", **arguments})
        return ("ERROR: " if result["is_error"] else "") + result["text"]


def osascript(script):
    return subprocess.run(["osascript", "-e", script], capture_output=True, text=True).stdout.strip()


def check(condition, message):
    print(f"  {'✔' if condition else '✘'} {message}")
    return condition


def bold():
    return "bold" in osascript('tell application "TextEdit" to get font of character 1 of document 1').lower()


def main():
    if subprocess.run(["pgrep", "-x", "TextEdit"], capture_output=True).returncode == 0:
        sys.exit("TextEdit is running; quit it first so no real document is touched.")
    results = []
    setup = Client()
    try:
        setup.call("get_app_state")
        setup.call("press_key", key="cmd+n")
        state = setup.call("get_app_state")
        area = next(line.split("]")[0].strip().lstrip("[") for line in state.splitlines() if "] TextArea" in line)
        setup.call("click", element_index=area)
        setup.call("type_text", text="Title")
        setup.call("press_key", key="cmd+a")
        time.sleep(2)  # TextEdit may activate itself once after launching; skfiy hands the front back

        before = frontmost()
        out = setup.call("run_in_front", key="super+b", reason="make the title bold")
        results.append(check(out.startswith("ERROR") and "cannot ask" in out and frontmost() == before and not bold(),
                             "a client that cannot ask the user: nothing happens"))

        declining = Client(DECLINE)
        declining.call("get_app_state")
        before = frontmost()
        out = declining.call("run_in_front", key="super+b", reason="make the title bold")
        after = frontmost()
        results.append(check(out.startswith("ERROR") and "declined" in out and len(declining.asked) == 1
                             and after == before and not bold(),
                             f"the user declines: nothing happens (asked {len(declining.asked)}×, front {before} -> {after}, {out[:70]!r})"))
        declining.close()

        if ACCEPT:
            print("  … waiting until you have been idle for 10 s (not in Ghostty)")
            while idle_seconds() < 10 or "Ghostty" in frontmost() or "TextEdit" in frontmost():
                time.sleep(1)
            accepting = Client(APPROVE)
            accepting.call("get_app_state")
            user = frontmost()
            out = accepting.call("run_in_front", key="super+b", reason="make the title bold")
            results.append(check(not out.startswith("ERROR") and bold(), f"the user approves: the title is bold ({out.splitlines()[0][:90]})"))
            results.append(check(frontmost() == user, f"the front app came back ({frontmost()})"))
            accepting.close()
    finally:
        osascript('tell application "TextEdit" to close every document saving no')
        osascript('tell application "TextEdit" to quit')
        setup.close()
    print(f"{sum(results)}/{len(results)} foreground checks passed")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
