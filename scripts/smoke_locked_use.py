#!/usr/bin/env python3
"""Opt-in, real-Mac locked-use smoke test against an isolated disposable app.

Never installs the plugin or approves the guardian dialog. After local approval,
the user manually locks the Mac; the test requests screenshots and AX clicks.
"""
import argparse
import json
import os
from pathlib import Path
import plistlib
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time


class Client:
    def __init__(self, binary):
        self.proc = subprocess.Popen([binary, "mcp", "--locked-use"], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, text=True, bufsize=1,
                                     env={**os.environ, "SKFIY_ACTION_LOG": "off"})
        self.messages = queue.Queue()
        self.counter = 0

        def reader():
            try:
                for line in self.proc.stdout:
                    self.messages.put(json.loads(line))
            except Exception as error:
                self.messages.put(error)
            finally:
                self.messages.put(EOFError("MCP exited; see guardian's error above"))
        threading.Thread(target=reader, daemon=True).start()

    def request(self, method, params, timeout=30):
        self.counter += 1
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.counter,
                                         "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()
        deadline = time.monotonic() + timeout
        while True:
            response = self.messages.get(timeout=max(0.01, deadline - time.monotonic()))
            if isinstance(response, Exception):
                raise response
            if response.get("method") == "elicitation/create":
                raise RuntimeError("Unexpected agent approval request; the test never approves actions automatically")
            if response.get("id") != self.counter:
                continue
            if "error" in response:
                raise RuntimeError(response["error"])
            return response["result"]

    def call(self, name, **arguments):
        result = self.request("tools/call", {"name": name, "arguments": arguments})
        text = "\n".join(item["text"] for item in result.get("content", []) if item["type"] == "text")
        if result.get("isError"):
            raise RuntimeError(f"{name}: {text}")
        return text, result

    def assert_locked(self):
        text, _ = self.call("get_desktop_status")
        if "Desktop: locked or unavailable." not in text or "Locked use: armed" not in text:
            raise AssertionError(f"Expected a relocked desktop with a live grant: {text}")

    def close(self):
        # EOF revokes the grant; never kill a guardian holding the display cover.
        self.proc.stdin.close()
        try:
            self.proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.proc.terminate()
            self.proc.wait(timeout=10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", nargs="?", default=".build/debug/skfiy")
    parser.add_argument("--allow-lock", action="store_true")
    parser.add_argument("--cycles", type=int, default=3)
    args = parser.parse_args()
    if sys.platform != "darwin" or not args.allow_lock:
        parser.error("Run on a test Mac with --allow-lock after reading locked-use/README.md")
    if not 1 <= args.cycles <= 100:
        parser.error("--cycles must be between 1 and 100")
    binary = str(Path(args.binary).expanduser().resolve())
    print(subprocess.check_output(["sw_vers"], text=True).strip(), flush=True)
    print(subprocess.check_output(["uname", "-m"], text=True).strip(), flush=True)
    source = Path(__file__).resolve().parent / "fixtures/LockedUseFixture.swift"
    with tempfile.TemporaryDirectory(prefix="skfiy-locked-use-") as folder:
        app = Path(folder) / "SkfiyLockedUseFixture.app"
        executable = app / "Contents/MacOS/fixture"
        executable.parent.mkdir(parents=True)
        with (app / "Contents/Info.plist").open("wb") as out:
            plistlib.dump({"CFBundleIdentifier": "io.github.sskift.locked-use-fixture",
                          "CFBundleName": "SkfiyLockedUseFixture", "CFBundleExecutable": "fixture",
                          "CFBundlePackageType": "APPL", "NSPrincipalClass": "NSApplication"}, out)
        subprocess.run(["swiftc", str(source), "-o", str(executable)], check=True)
        subprocess.run(["codesign", "--force", "--sign", "-", str(app)], check=True)
        fixture = subprocess.Popen([str(executable)])
        client = None
        try:
            print("Approve the local guardian dialog and system authentication. No password goes to this script.", flush=True)
            client = Client(binary)
            client.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                          "clientInfo": {"name": "skfiy-locked-use-smoke", "version": "1"}}, timeout=100)
            target = "io.github.sskift.locked-use-fixture"
            text, _ = client.call("get_app_state", app=target)
            if "locked-use-count:0" not in text:
                raise AssertionError("Fixture did not start in its initial state")
            print("Lock your Mac now (Control-Command-Q), then leave keyboard/mouse untouched until it finishes.", flush=True)
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                text, _ = client.call("get_desktop_status")
                if "Desktop: locked or unavailable." in text:
                    break
                time.sleep(0.3)
            else:
                raise TimeoutError("Mac was not locked within 60 seconds")
            time.sleep(2)  # Let the lock shortcut's key-up events finish.
            for counter in range(1, args.cycles + 1):
                text, result = client.call("get_app_state", app=target)
                if not any(item["type"] == "image" for item in result["content"]):
                    raise AssertionError("Locked-use screenshot was unavailable")
                client.assert_locked()
                button = re.search(r'\[(\d+)\] Button "Increment locked-use counter"', text)
                if not button:
                    raise AssertionError("Fixture button absent from AX tree")
                client.call("click", app=target, element_index=button.group(1))
                client.assert_locked()
                text, _ = client.call("get_app_state", app=target)
                if f"locked-use-count:{counter}" not in text:
                    raise AssertionError("Background click did not change the fixture")
                client.assert_locked()
                print(f"PASS cycle {counter}: screenshot, AX click, state change, relock", flush=True)
            print("PASS. Unlock manually. Keychain, Touch ID fallback and interruption tests still need manual validation.", flush=True)
        finally:
            try:
                if client:
                    client.close()
            finally:
                fixture.terminate()
                fixture.wait(timeout=10)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FAIL: {error}. Unlock manually; do not replay an uncertain action.", file=sys.stderr)
        sys.exit(1)
