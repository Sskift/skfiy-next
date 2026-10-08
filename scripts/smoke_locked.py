#!/usr/bin/env python3
"""Shared fixture, evidence and MCP helpers for direct locked-use acceptance;
its Client, Evidence and require are also the MCP client and evidence log of
scenario.py and compat_baseline.py.

This is a support module. Run smoke_locked_direct.py or
smoke_locked_direct_multiwindow.py for direct-mode acceptance; the separate
upstream guardian harness is smoke_locked_use.py. These helpers never install
an authorization plugin, lock/unlock macOS, or inject global HID events.
"""
import base64
import json
import os
from pathlib import Path
import plistlib
import queue
import subprocess
import threading
import time


ROOT = Path(__file__).resolve().parent.parent

# The independent probe only observes session state or OCRs a supplied fixture
# screenshot. Sampling both ends detects state transitions during collection.
PROBE_SOURCE = r'''
import AppKit
import ApplicationServices
import Darwin
import Foundation
import ImageIO
import Vision

func output(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data([10]))
}
func die(_ text: String) -> Never {
    FileHandle.standardError.write(Data((text + "\n").utf8)); exit(1)
}
func observedSession() -> (known: Bool, locked: Bool) {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
          session["kCGSSessionOnConsoleKey"] as? Bool == true,
          session["kCGSessionLoginDoneKey"] as? Bool == true,
          let uid = session["kCGSSessionUserIDKey"] as? Int,
          uid == Int(getuid()) else {
        return (false, false)
    }
    // macOS omits this key when the logged-in console session is unlocked.
    return (true, session["CGSSessionScreenIsLocked"] as? Bool == true)
}
func sample() -> [String: Any] {
    let started = ProcessInfo.processInfo.systemUptime
    let initial = observedSession()
    let accessibility = AXIsProcessTrusted()
    let screenCapture = CGPreflightScreenCaptureAccess()
    let final = observedSession()
    let transition = !initial.known || !final.known ? "unknown"
        : initial.locked == final.locked ? "stable" : initial.locked ? "unlocking" : "relocking"
    return ["timestamp": Date().timeIntervalSince1970, "uptime": ProcessInfo.processInfo.systemUptime,
            "sampleStartedUptime": started, "sampleDuration": ProcessInfo.processInfo.systemUptime - started,
            "known": initial.known && final.known, "knownAtStart": initial.known, "knownAtEnd": final.known,
            "osLocked": final.locked, "osLockedAtStart": initial.locked, "lockTransition": transition,
            "accessibility": accessibility, "screenCapture": screenCapture]
}
let arguments = Array(CommandLine.arguments.dropFirst())
switch arguments.first ?? "--sample" {
case "--sample": output(sample())
case "--watch":
    while true { output(sample()); usleep(50_000) }
case "--ocr":
    guard arguments.count > 1,
          let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: arguments[1]) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { die("Cannot decode fixture screenshot") }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.recognitionLanguages = ["en-US"]
    do { try VNImageRequestHandler(cgImage: image).perform([request]) } catch { die("OCR: \(error)") }
    output(["width": image.width, "height": image.height,
            "lines": request.results?.compactMap { $0.topCandidates(1).first?.string } ?? []])
default: die("Unknown probe mode")
}
'''


def run(*args, timeout=20):
    return subprocess.run([str(arg) for arg in args], check=True, capture_output=True, text=True, timeout=timeout).stdout


def require(condition, message):
    if not condition:
        raise AssertionError(message)


class Evidence:
    def __init__(self, directory):
        self.directory = directory
        self.events = (directory / "harness.jsonl").open("x", buffering=1)
        self.sequence = 0

    def record(self, event, **details):
        self.sequence += 1
        row = {"sequence": self.sequence, "timestamp": time.time(), "monotonic": time.monotonic(), "event": event, **details}
        self.events.write(json.dumps(row, ensure_ascii=False) + "\n")
        return row


class Client:
    def __init__(self, binary, evidence, *, environment=None, name="skfiy-lock-smoke"):
        self.evidence = evidence
        self.next_id = 0
        self.inbox = queue.Queue()
        self.stderr = (evidence.directory / "mcp.stderr").open("x")
        self.proc = subprocess.Popen([str(binary), "mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=self.stderr, text=True, bufsize=1,
                                     env={**os.environ, **(environment or {}),
                                          "SKFIY_ACTION_LOG": str(evidence.directory / "actions.jsonl"),
                                          "SKFIY_STOP_FILE": str(evidence.directory / "stopped")})

        def read():
            try:
                for line in self.proc.stdout:
                    self.inbox.put(json.loads(line))
            except Exception as error:
                self.inbox.put(error)
            finally:
                self.inbox.put(EOFError("MCP stdout closed"))

        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()
        try:
            self.request("initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
                                        "clientInfo": {"name": name, "version": "1"}})
            self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        except BaseException:
            self.close()
            raise

    def send(self, value):
        self.proc.stdin.write(json.dumps(value) + "\n")
        self.proc.stdin.flush()

    def request(self, method, params, timeout=25):
        self.next_id += 1
        request_id = self.next_id
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + timeout
        while True:
            reply = self.inbox.get(timeout=max(0.01, deadline - time.monotonic()))
            if isinstance(reply, Exception):
                raise reply
            if reply.get("method") == "elicitation/create":
                self.send({"jsonrpc": "2.0", "id": reply["id"], "result": {"action": "decline"}})
                raise AssertionError("The isolated lock smoke unexpectedly asked for approval.")
            if reply.get("id") != request_id:
                self.evidence.record("mcp_notification", message=reply)
                require(time.monotonic() < deadline, "MCP reply deadline elapsed")
                continue
            if "error" in reply:
                raise RuntimeError(reply["error"])
            return reply["result"]

    def call(self, tool, allow_error=False, rpc_timeout=25, **arguments):
        began = time.time()
        result = self.request("tools/call", {"name": tool, "arguments": arguments}, timeout=rpc_timeout)
        text = "\n".join(block["text"] for block in result.get("content", []) if block.get("type") == "text")
        images = []
        for offset, block in enumerate(result.get("content", [])):
            if block.get("type") == "image":
                suffix = ".png" if block.get("mimeType") == "image/png" else ".jpg"
                path = self.evidence.directory / f"tool-{self.next_id:03d}-{offset}{suffix}"
                path.write_bytes(base64.b64decode(block["data"], validate=True))
                images.append(str(path))
        self.evidence.record("tool", tool=tool, arguments=arguments, started=began,
                             is_error=bool(result.get("isError")), text=text, images=images)
        if not allow_error:
            require(not result.get("isError"), f"{tool}: {text}")
        return {"text": text, "images": images, "is_error": bool(result.get("isError"))}

    def close(self):
        if self.proc.poll() is None:
            try:
                self.proc.stdin.close()
            except BrokenPipeError:
                pass
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=3)
        self.reader.join(timeout=1)
        self.stderr.close()


def build_helpers(directory, nonce):
    probe_source = directory / "LockProbe.swift"
    probe_source.write_text(PROBE_SOURCE)
    probe = directory / "LockProbe"
    run("/usr/bin/swiftc", "-O", probe_source, "-o", probe, timeout=90)
    app = directory / f"SkfiyLockedFixture-{nonce}.app"
    macos = app / "Contents/MacOS"
    macos.mkdir(parents=True)
    with (app / "Contents/Info.plist").open("xb") as output:
        plistlib.dump({"CFBundleIdentifier": f"com.skfiy.lockedfixture.{nonce}",
                       "CFBundleName": f"SkfiyLockedFixture-{nonce}", "CFBundleExecutable": "LockedFixture",
                       "CFBundlePackageType": "APPL", "NSPrincipalClass": "NSApplication", "LSUIElement": True}, output)
    fixture = macos / "LockedFixture"
    run("/usr/bin/swiftc", "-O", ROOT / "scripts/fixtures/LockedFixture.swift", "-o", fixture, timeout=90)
    run("/usr/bin/codesign", "--force", "--sign", "-", app)
    return probe, app, fixture


def probe_sample(probe):
    return json.loads(run(probe, "--sample", timeout=5))


def wait_for(check, message, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.1)
    raise AssertionError(message)


if __name__ == "__main__":
    raise SystemExit("Use scripts/smoke_locked_direct.py or scripts/smoke_locked_direct_multiwindow.py for direct acceptance.")
