#!/usr/bin/env python3
"""run_in_front smoke test: the one tool that brings an app forward.

Declined and unsupported approvals must change nothing. With --accept it also
brings TextEdit forward once, to make a word bold, after waiting until you
have been away from the keyboard and mouse for 10 s, and then checks that your
front app came back. TextEdit must not be running.

    python3 scripts/smoke_foreground.py [path/to/skfiy] [--accept]
"""
import json
import subprocess
import sys
import time

ARGS = [arg for arg in sys.argv[1:] if not arg.startswith("--")]
BINARY = ARGS[0] if ARGS else ".build/debug/skfiy"
ACCEPT = "--accept" in sys.argv


class Client:
    def __init__(self, elicitation, answer):
        self.proc = subprocess.Popen([BINARY, "mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.answer = answer
        self.asked = []
        self.next_id = 0
        capabilities = {"elicitation": {"form": {}}} if elicitation else {}
        self.request("initialize", {"protocolVersion": "2025-11-25", "capabilities": capabilities, "clientInfo": {"name": "smoke", "version": "0"}})

    def send(self, message):
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def request(self, method, params):
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params})
        while True:
            message = json.loads(self.proc.stdout.readline())
            if message.get("method") == "elicitation/create":
                self.asked.append(message["params"]["message"])
                self.send({"jsonrpc": "2.0", "id": message["id"], "result": self.answer})
            elif message.get("id") == self.next_id:
                return message["result"]

    def call(self, tool, **arguments):
        result = self.request("tools/call", {"name": tool, "arguments": {"app": "TextEdit", **arguments}})
        return ("ERROR: " if result["isError"] else "") + result["content"][0]["text"]

    def close(self):
        self.proc.stdin.close()


def osascript(script):
    return subprocess.run(["osascript", "-e", script], capture_output=True, text=True).stdout.strip()


def front():
    asn = subprocess.run(["lsappinfo", "front"], capture_output=True, text=True).stdout.strip()
    return subprocess.run(["lsappinfo", "info", "-only", "name", asn], capture_output=True, text=True).stdout.strip()


def idle_seconds():
    output = subprocess.run(["ioreg", "-c", "IOHIDSystem", "-d", "4"], capture_output=True, text=True).stdout
    for line in output.splitlines():
        if "HIDIdleTime" in line:
            return int(line.split("=")[-1]) / 1e9
    return 0


def check(condition, message):
    print(f"  {'✔' if condition else '✘'} {message}")
    return condition


def bold():
    return "bold" in osascript('tell application "TextEdit" to get font of character 1 of document 1').lower()


def main():
    if subprocess.run(["pgrep", "-x", "TextEdit"], capture_output=True).returncode == 0:
        sys.exit("TextEdit is running; quit it first so no real document is touched.")
    results = []
    setup = Client(elicitation=False, answer=None)
    try:
        setup.call("get_app_state")
        setup.call("press_key", key="cmd+n")
        state = setup.call("get_app_state")
        area = next(line.split("]")[0].strip().lstrip("[") for line in state.splitlines() if "] TextArea" in line)
        setup.call("click", element_index=area)
        setup.call("type_text", text="Title")
        setup.call("press_key", key="cmd+a")

        before = front()
        out = setup.call("run_in_front", key="super+b", reason="make the title bold")
        results.append(check(out.startswith("ERROR") and "cannot ask" in out and front() == before and not bold(),
                             "a client that cannot ask the user: nothing happens"))

        declining = Client(elicitation=True, answer={"action": "decline"})
        declining.call("get_app_state")
        out = declining.call("run_in_front", key="super+b", reason="make the title bold")
        results.append(check(out.startswith("ERROR") and "declined" in out and len(declining.asked) == 1
                             and front() == before and not bold(), "the user declines: nothing happens"))
        declining.close()

        if ACCEPT:
            print("  … waiting until you have been idle for 10 s (not in Ghostty)")
            while idle_seconds() < 10 or "Ghostty" in front() or "TextEdit" in front():
                time.sleep(1)
            accepting = Client(elicitation=True, answer={"action": "accept", "content": {"allow": True}})
            accepting.call("get_app_state")
            user = front()
            out = accepting.call("run_in_front", key="super+b", reason="make the title bold")
            results.append(check(not out.startswith("ERROR") and bold(), f"the user approves: the title is bold ({out.splitlines()[0][:90]})"))
            results.append(check(front() == user, f"the front app came back ({front()})"))
            accepting.close()
    finally:
        osascript('tell application "TextEdit" to close every document saving no')
        osascript('tell application "TextEdit" to quit')
        setup.close()
    print(f"{sum(results)}/{len(results)} foreground checks passed")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
