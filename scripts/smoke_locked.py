#!/usr/bin/env python3
"""Exercise skfiy's installed guarded unlock route against an isolated fixture.

Without --lock this only reads installation metadata; it never changes GUI
state. Each --lock run starts while manually unlocked and finishes OS-locked.
Run the cases separately, manually unlocking between them:

  python3 scripts/smoke_locked.py '/Library/Application Support/skfiy/locked-use/skfiy' --lock --case end
  python3 scripts/smoke_locked.py '/Library/Application Support/skfiy/locked-use/skfiy' --lock --case parent-crash
  python3 scripts/smoke_locked.py '/Library/Application Support/skfiy/locked-use/skfiy' --lock --case guardian-crash
  python3 scripts/smoke_locked.py '/Library/Application Support/skfiy/locked-use/skfiy' --lock --case hid

The hid case injects a same-position mouse event into the HID stream. It tests
the interruption path; a real keyboard/mouse check remains a separate test.
The script never submits a password or manually unlocks the system. Desktop
work is accepted only with a live guardian, display covers and an enabled HID
tap, followed by confirmed OS relocking. Evidence goes under eval/results.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import plistlib
import queue
import re
import signal
import subprocess
import sys
import threading
import time
import uuid


ROOT = Path(__file__).resolve().parent.parent
INSTALLED = Path("/Library/Application Support/skfiy/locked-use/skfiy")
GUARDIAN = Path("/Library/PrivilegedHelperTools/com.skfiy.LockedUseGuardian")
PLUGIN = Path("/Library/Security/SecurityAgentPlugins/SkfiyLockedUse.bundle")
REMOTE_RIGHT = "com.skfiy.locked-use.remote"
PLUGIN_SIGNING_REQUIREMENT = "anchor apple generic and certificate leaf[subject.OU] exists"

# Kept here so the smoke harness has one entry point and builds its own probe.
# The probe observes only lock state, display geometry and the named guardian's
# windows/taps. OCR reads the fixture screenshot explicitly handed to it.
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
func rectangle(_ rect: CGRect) -> [String: Double] {
    ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
}
func sample(_ guardian: pid_t, _ watchdog: pid_t) -> [String: Any] {
    let sampleStarted = ProcessInfo.processInfo.systemUptime
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    let known = session != nil && (session?["kCGSSessionOnConsoleKey"] as? Bool) == true
        && (session?["kCGSessionLoginDoneKey"] as? Bool) == true
    var count: UInt32 = 0
    _ = CGGetActiveDisplayList(0, nil, &count)
    var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
    if count > 0 { _ = CGGetActiveDisplayList(count, &displays, &count) }
    displays = Array(displays.prefix(Int(count)))
    let displayBounds = displays.map { (id: $0, bounds: CGDisplayBounds($0)) }
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    var tapCount: UInt32 = 0
    let listing = CGGetEventTapList(0, nil, &tapCount)
    var taps = [CGEventTapInformation](repeating: CGEventTapInformation(), count: Int(tapCount))
    var tapResult = listing
    if tapCount > 0 { tapResult = CGGetEventTapList(tapCount, &taps, &tapCount) }
    let guards: [[String: Any]] = [(guardian, "primary"), (watchdog, "watchdog")].filter { $0.0 > 0 }.map { pid, role in
        let covers = windows.filter {
            ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid)
            && ($0[kCGWindowLayer as String] as? Int ?? 0) >= Int(CGShieldingWindowLevel())
            && ($0[kCGWindowAlpha as String] as? Double ?? 0) >= 0.99
        }
        let rectangles = covers.compactMap { row -> CGRect? in
            guard let bounds = row[kCGWindowBounds as String] as? NSDictionary else { return nil }
            return CGRect(dictionaryRepresentation: bounds)
        }
        let covered = !displayBounds.isEmpty && displayBounds.allSatisfy { display in
            rectangles.contains { $0.insetBy(dx: -1, dy: -1).contains(display.bounds) }
        }
        let coverDetails: [[String: Any]] = covers.map { row in
            var detail: [String: Any] = ["windowID": row[kCGWindowNumber as String] as? Int ?? -1,
                "layer": row[kCGWindowLayer as String] as? Int ?? 0,
                "alpha": row[kCGWindowAlpha as String] as? Double ?? 0]
            if let raw = row[kCGWindowBounds as String] as? NSDictionary,
               let bounds = CGRect(dictionaryRepresentation: raw) { detail["bounds"] = rectangle(bounds) }
            return detail
        }
        let coverage: [[String: Any]] = displayBounds.map { display in
            ["displayID": display.id, "bounds": rectangle(display.bounds),
             "covered": rectangles.contains { $0.insetBy(dx: -1, dy: -1).contains(display.bounds) }]
        }
        let enabledTap = tapResult == .success && taps.prefix(Int(tapCount)).contains {
            $0.tappingProcess == pid && $0.enabled && $0.tapPoint == .cghidEventTap && $0.options == .defaultTap
        }
        let alive = kill(pid, 0) == 0
        return ["pid": Int(pid), "role": role, "alive": alive, "coverCount": covers.count,
                "covers": coverDetails, "displayCoverage": coverage,
                "allDisplaysCovered": covered, "hidTapEnabled": enabledTap,
                "protectionVerified": alive && covered && enabledTap]
    }
    let protectingPIDs = guards.filter { $0["protectionVerified"] as? Bool == true }.compactMap { $0["pid"] as? Int }
    // Collection is not atomic. A completed relock can legitimately remove
    // both guards after the first dictionary read, so also record lock state
    // at the end of the sample instead of reporting that as an exposure.
    let finalSession = CGSessionCopyCurrentDictionary() as? [String: Any]
    let finalKnown = finalSession != nil && (finalSession?["kCGSSessionOnConsoleKey"] as? Bool) == true
        && (finalSession?["kCGSessionLoginDoneKey"] as? Bool) == true
    let initiallyLocked = (session?["CGSSessionScreenIsLocked"] as? Bool) ?? false
    let finallyLocked = (finalSession?["CGSSessionScreenIsLocked"] as? Bool) ?? false
    let transition = !known || !finalKnown ? "unknown" : initiallyLocked == finallyLocked ? "stable" : initiallyLocked ? "unlocking" : "relocking"
    return ["timestamp": Date().timeIntervalSince1970, "uptime": ProcessInfo.processInfo.systemUptime,
            "sampleStartedUptime": sampleStarted, "sampleDuration": ProcessInfo.processInfo.systemUptime - sampleStarted,
            "known": known && finalKnown, "knownAtStart": known, "knownAtEnd": finalKnown,
            "osLocked": finallyLocked, "osLockedAtStart": initiallyLocked, "lockTransition": transition,
            "displayCount": displays.count, "guardianPID": Int(guardian), "watchdogPID": Int(watchdog),
            "displayBounds": displayBounds.map { ["displayID": $0.id, "bounds": rectangle($0.bounds)] as [String: Any] },
            "guardianAlive": guardian > 0 && kill(guardian, 0) == 0,
            "guards": guards, "protectingPIDs": protectingPIDs, "protectionVerified": !protectingPIDs.isEmpty,
            "coverCount": guards.reduce(0) { $0 + ($1["coverCount"] as? Int ?? 0) },
            "allDisplaysCovered": guards.contains { $0["allDisplaysCovered"] as? Bool == true },
            "hidTapEnabled": guards.contains { $0["hidTapEnabled"] as? Bool == true },
            "tapInspectionAvailable": tapResult == .success,
            "accessibility": AXIsProcessTrusted(), "screenCapture": CGPreflightScreenCaptureAccess()]
}
let arguments = Array(CommandLine.arguments.dropFirst())
let mode = arguments.first ?? "--sample"
let guardian = arguments.count > 1 ? Int32(arguments[1]) ?? 0 : 0
let watchdog = arguments.count > 2 ? Int32(arguments[2]) ?? 0 : 0
switch mode {
case "--sample": output(sample(guardian, watchdog))
case "--watch":
    while true { output(sample(guardian, watchdog)); usleep(50_000) }
case "--lock":
    guard let handle = dlopen("/System/Library/PrivateFrameworks/login.framework/Versions/Current/login", RTLD_NOW),
          let symbol = dlsym(handle, "SACLockScreenImmediate") else { die("SACLockScreenImmediate unavailable") }
    typealias LockFunction = @convention(c) () -> Int32
    let code = unsafeBitCast(symbol, to: LockFunction.self)()
    guard code == 0 else { die("OS lock request failed: \(code)") }
    output(sample(guardian, watchdog))
case "--interrupt":
    guard let current = CGEvent(source: nil),
          let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                              mouseCursorPosition: current.location, mouseButton: .left) else { die("Cannot create HID probe event") }
    event.post(tap: .cghidEventTap)
    output(["timestamp": Date().timeIntervalSince1970, "injected": "same_position_mouse_move"])
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


def installation_check(binary):
    """Read-only: do not launch the MCP, fixture, guardian or any GUI."""
    checks = []
    for path in (binary, INSTALLED, GUARDIAN, PLUGIN):
        exists = path.exists()
        info = path.stat() if exists else None
        checks.append({"path": str(path), "exists": exists,
                       "root_owned": info is not None and info.st_uid == 0,
                       "protected_mode": info is not None and not bool(info.st_mode & 0o022)})
    errors = []
    for path in (INSTALLED, GUARDIAN, PLUGIN):
        if not path.exists():
            errors.append(f"Missing installed artifact: {path}")
        elif path.is_symlink() or path.stat().st_uid != 0 or path.stat().st_mode & 0o022:
            errors.append(f"Installed artifact is not root-protected: {path}")
        else:
            try:
                run("/usr/bin/codesign", "--verify", "--strict", path)
                if path == PLUGIN:
                    run("/usr/bin/codesign", "--verify", "--strict", "--all-architectures",
                        "-R=" + PLUGIN_SIGNING_REQUIREMENT, path)
            except subprocess.SubprocessError as error:
                errors.append(f"Signature verification failed for {path}: {error}")
    if not binary.is_file() or not os.access(binary, os.X_OK):
        errors.append(f"Not an executable MCP binary: {binary}")
    try:
        screen = plistlib.loads(subprocess.check_output(
            ["/usr/bin/security", "authorizationdb", "read", "system.login.screensaver"], stderr=subprocess.DEVNULL, timeout=10))
        rules = screen.get("rule", [])
        rules = [rules] if isinstance(rules, str) else rules
        if not isinstance(rules, list) or REMOTE_RIGHT not in rules:
            errors.append("The installed authorization mechanism is absent from the screen-unlock rule.")
        remote = plistlib.loads(subprocess.check_output(
            ["/usr/bin/security", "authorizationdb", "read", REMOTE_RIGHT], stderr=subprocess.DEVNULL, timeout=10))
        if "SkfiyLockedUse:remote" not in remote.get("mechanisms", []):
            errors.append("The custom authorization right does not name SkfiyLockedUse:remote.")
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        errors.append(f"Could not verify installed authorization rules: {error}")
    return {"ready": not errors, "artifacts": checks, "errors": errors}


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
    def __init__(self, binary, evidence):
        self.evidence = evidence
        self.next_id = 0
        self.inbox = queue.Queue()
        self.stderr = (evidence.directory / "mcp.stderr").open("x")
        self.proc = subprocess.Popen([str(binary), "mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=self.stderr, text=True, bufsize=1,
                                     env={**os.environ, "SKFIY_LOCKED_USE": "1",
                                          "SKFIY_LOCKED_USE_SECONDS": "600",
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
                                        "clientInfo": {"name": "skfiy-lock-smoke", "version": "1"}})
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

    def status(self, timeout=25):
        return json.loads(self.call("locked_use_status", rpc_timeout=timeout)["text"])

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


def probe_sample(probe, guardian=0, watchdog=0):
    return json.loads(run(probe, "--sample", guardian, watchdog, timeout=5))


def wait_for(check, message, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.1)
    raise AssertionError(message)


def find_guardian(parent, role="primary"):
    def search():
        for line in run("/bin/ps", "-axo", "pid=,ppid=,comm=").splitlines():
            columns = line.strip().split(maxsplit=2)
            if len(columns) == 3 and int(columns[1]) == parent and columns[2] == str(GUARDIAN):
                return int(columns[0])
        return None
    return wait_for(search, f"Could not verify the {role} guardian child of PID {parent}.")


def element(tree, pattern):
    for line in tree.splitlines():
        if re.search(pattern, line):
            match = re.search(r"\[(\d+)\]", line)
            if match:
                return int(match[1])
    raise AssertionError(f"No fixture element matches {pattern!r}")


def point_in_screenshot(tree, frame):
    match = re.search(r"Screenshot: (\d+)×\d+ px showing screen region x=(-?\d+) y=(-?\d+) w=(\d+)", tree)
    require(match is not None, "No fresh screenshot geometry for pointer test")
    pixels, left, top, width = map(int, match.groups())
    scale = pixels / width
    return ((frame["x"] + frame["width"] / 4 - left) * scale,
            (frame["y"] + frame["height"] / 2 - top) * scale)


def run_locked(options, preflight):
    nonce = uuid.uuid4().hex[:12]
    directory = ROOT / "eval/results" / (time.strftime("locked-use-%Y%m%d-%H%M%S-") + nonce)
    directory.mkdir(parents=True, mode=0o700)
    evidence = Evidence(directory)
    summary = {"ok": False, "case": options.case, "nonce": nonce, "artifacts": str(directory),
               "preflight": preflight, "started": time.time(), "actual_lock_observed": False}
    client = fixture = watcher = None
    guardian = watchdog = 0
    probe = None
    lock_requested = False
    fixture_error = watcher_output = watcher_error = None
    print(f"Evidence: {directory}", flush=True)
    try:
        guardian_preflight = json.loads(run(GUARDIAN, "--preflight"))
        evidence.record("guardian_preflight", result=guardian_preflight)
        require(guardian_preflight.get("accessibility") and guardian_preflight.get("lockAPI")
                and guardian_preflight.get("sessionKnown") and guardian_preflight.get("consoleOwner")
                and guardian_preflight.get("osLocked") is False,
                "Installed guardian preflight failed; finish its --request-permissions flow and manually unlock before testing: "
                + str(guardian_preflight))
        probe, app, fixture_binary = build_helpers(directory, nonce)
        initial = probe_sample(probe)
        evidence.record("initial_session", state=initial)
        require(initial["known"] and not initial["osLocked"], "Start this test while the owner has manually unlocked the Mac.")
        require(initial["accessibility"] and initial["screenCapture"], "Grant the test host Accessibility and Screen Recording before --lock.")
        client = Client(options.binary, evidence)
        tools = client.request("tools/list", {})
        require({"locked_use_status", "locked_use_end", "get_app_state", "click", "set_value", "type_text"}.issubset(
            {tool["name"] for tool in tools["tools"]}), "Installed MCP lacks required locked-use tools.")
        status = client.status()
        require(status.get("phase") == "armed" and not status.get("protected") and status.get("osLocked") is False,
                f"Guardian did not arm while unlocked: {status}")
        guardian = find_guardian(client.proc.pid)
        watchdog = find_guardian(guardian, role="watchdog")
        summary["mcp_pid"], summary["guardian_pid"], summary["watchdog_pid"] = client.proc.pid, guardian, watchdog
        evidence.record("guardian_identities", primary={"pid": guardian, "parent": client.proc.pid, "executable": str(GUARDIAN)},
                        watchdog={"pid": watchdog, "parent": guardian, "executable": str(GUARDIAN)})
        fixture_error = (directory / "fixture.stderr").open("x")
        fixture = subprocess.Popen([str(fixture_binary), "--journal", str(directory / "fixture.json"), "--nonce", nonce],
                                   stdout=subprocess.DEVNULL, stderr=fixture_error)

        def state():
            try:
                value = json.loads((directory / "fixture.json").read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                return None
            require(value["run_nonce"] == nonce and value["pid"] == fixture.pid, "Fixture identity changed")
            return value

        before = wait_for(state, "Fixture did not become ready.")
        app_query = str(app)
        baseline = client.call("get_app_state", app=app_query)
        require(nonce in baseline["text"], "Unlocked fixture state did not contain this run's nonce")
        require(baseline["images"], "Cannot capture the fixture before locking; no lock was attempted")
        require(not state()["app_active"], "Fixture unexpectedly activated during the unlocked baseline")
        require(client.status().get("phase") == "armed", "Guardian must still be armed before the actual lock")
        watcher_output = (directory / "protection.jsonl").open("x")
        watcher_error = (directory / "probe.stderr").open("x")
        watcher = subprocess.Popen([str(probe), "--watch", str(guardian), str(watchdog)], stdout=watcher_output, stderr=watcher_error)
        print(f"Locking for {options.case}; the Mac will remain locked when this test finishes.", flush=True)
        lock_requested = True
        run(probe, "--lock", guardian, watchdog)
        locked = wait_for(lambda: (sample if (sample := probe_sample(probe, guardian, watchdog))["known"] and sample["osLocked"] else None),
                          "macOS never confirmed an actual lock")
        summary["actual_lock_observed"] = True
        evidence.record("actual_os_lock", state=locked)
        lock_tick = state()["tick"]
        guarded = client.call("get_app_state", app=app_query)

        def protected():
            require(watcher.poll() is None, "The independent protection sampler exited")
            current = client.status()
            observed = probe_sample(probe, guardian, watchdog)
            evidence.record("protected_checkpoint", status=current, observation=observed)
            require(current.get("phase") == "protected" and current.get("protected") is True
                    and current.get("osLocked") is False and current.get("displays", 0) > 0,
                    f"MCP did not report an active protected session: {current}")
            require(observed["known"] and not observed["osLocked"] and observed["guardianAlive"]
                    and guardian in observed["protectingPIDs"] and watchdog in observed["protectingPIDs"],
                    f"Independent display/HID protection check failed: {observed}")
            require(current["displays"] == observed["displayCount"], "Guardian did not cover the active display count")
            return current

        protected()
        require(state()["tick"] > lock_tick and nonce in guarded["text"], "Locked continuation did not return fresh fixture state")
        input_index = element(guarded["text"], r"TextField.*Fixture nonce|TextField")
        value = "skfiy" + nonce[:8]
        client.call("set_value", app=app_query, element_index=input_index, value=value)
        wait_for(lambda: state()["input_value"] == value, "AX value was not independently observed by the fixture")
        protected()
        fresh = client.call("get_app_state", app=app_query)
        commit_index = element(fresh["text"], r'Button "Commit nonce"')
        prior = state()["commit_count"]
        client.call("click", app=app_query, element_index=commit_index)
        wait_for(lambda: state()["commit_count"] == prior + 1 and state()["committed_value"] == value,
                 "Semantic click did not commit the nonce in the fixture")
        protected()
        fresh = client.call("get_app_state", app=app_query)
        require(fresh["images"], "No protected fixture screenshot")
        ocr = json.loads(run(probe, "--ocr", fresh["images"][0], timeout=20))
        evidence.record("screenshot_ocr", result=ocr)
        normalized = re.sub(r"[^a-z0-9]", "", " ".join(ocr["lines"]).lower())
        require(value in normalized, f"Protected screenshot lacks the newly committed nonce: {ocr['lines']}")
        require(hashlib.sha256(Path(fresh["images"][0]).read_bytes()).digest()
                != hashlib.sha256(Path(baseline["images"][0]).read_bytes()).digest(), "Screenshot was unchanged from the unlocked baseline")
        x, y = point_in_screenshot(fresh["text"], state()["frames"]["canvas"])
        pointer_before = state()["pointer_count"]
        client.call("click", app=app_query, x=x, y=y)
        wait_for(lambda: state()["pointer_count"] == pointer_before + 1 and state()["pointer_side"] == "green",
                 "Pixel click did not reach the fixture's custom canvas")
        protected()
        fresh = client.call("get_app_state", app=app_query)
        input_index = element(fresh["text"], r"TextField")
        client.call("click", app=app_query, element_index=input_index)
        keys_before = state()["key_down_count"]
        client.call("type_text", app=app_query, text="z")
        wait_for(lambda: state()["input_value"] == value + "z", "Typed nonce suffix did not arrive")
        require(state()["key_down_count"] > keys_before, "Typing used only a semantic fallback; real keyboard delivery was not verified")
        protected()
        summary["functional_checks"] = ["fresh_state", "set_value", "semantic_click", "fresh_screenshot_ocr", "pixel_click", "keyboard_delivery"]
        summary["fixture_final"] = state()
        evidence.record("functional_checks_passed", state=state())

        if options.case == "end":
            ending = client.call("locked_use_end")
            evidence.record("explicit_end", result=ending["text"])
        elif options.case == "parent-crash":
            evidence.record("kill_parent", pid=client.proc.pid)
            client.proc.kill()
            client.proc.wait(timeout=5)
        elif options.case == "guardian-crash":
            # Recheck ancestry and the exact installed executable immediately
            # before killing only the primary process owned by this test.
            require(find_guardian(client.proc.pid) == guardian and find_guardian(guardian, role="watchdog") == watchdog,
                    "Guardian process identity changed before crash injection")
            evidence.record("kill_guardian", primary_pid=guardian, surviving_watchdog_pid=watchdog)
            os.kill(guardian, signal.SIGKILL)
        else:
            evidence.record("hid_interruption", kind="injected_same_position_mouse_move")
            run(probe, "--interrupt", guardian, watchdog)

        def relocked():
            sample = probe_sample(probe, guardian, watchdog)
            if sample["known"] and sample["osLocked"] and sample["coverCount"] == 0 and not sample["hidTapEnabled"]:
                return sample
            return None

        final = wait_for(relocked, "OS did not relock and retire its display/input guards", timeout=12)
        evidence.record("final_os_lock", state=final)
        if options.case not in ("parent-crash", "guardian-crash"):
            status = client.status()
            require(status.get("osLocked") is True and status.get("protected") is False and status.get("displays") == 0,
                    f"Guardian status did not confirm completed relock: {status}")
            if options.case == "hid":
                require(status.get("phase") in ("suspended", "expired"), f"HID did not suspend the lease: {status}")
                refused = client.call("get_app_state", app=app_query, allow_error=True)
                require(refused["is_error"], "HID interruption allowed automatic continuation before manual unlock")
                require(probe_sample(probe, guardian, watchdog)["osLocked"], "Refused continuation unexpectedly unlocked the OS")
        summary["final_observation"] = final
        summary["ok"] = True
    except BaseException as error:
        summary["error"] = f"{type(error).__name__}: {error}"
        evidence.record("failure", error=summary["error"])
        if client is not None and client.proc.poll() is None:
            try:
                summary["failure_status"] = client.status(timeout=5)
                evidence.record("failure_guardian_status", status=summary["failure_status"])
            except Exception as status_error:
                summary["failure_status_error"] = str(status_error)
                evidence.record("failure_status_error", error=str(status_error))
    finally:
        # End the authorized route before closing its pipes. If anything failed
        # after the actual lock request, force another OS lock as a fallback.
        if lock_requested and probe is not None:
            if client is not None and client.proc.poll() is None:
                try:
                    client.call("locked_use_end", allow_error=True)
                except Exception as error:
                    evidence.record("cleanup_end_error", error=str(error))
            try:
                observed = probe_sample(probe, guardian, watchdog)
                if not observed["known"] or not observed["osLocked"]:
                    run(probe, "--lock", guardian, watchdog)
                wait_for(lambda: probe_sample(probe, guardian, watchdog)["osLocked"], "Cleanup could not confirm OS lock", timeout=8)
            except Exception as error:
                summary["ok"] = False
                summary["cleanup_lock_error"] = str(error)
        if client is not None:
            try:
                client.close()
            except Exception as error:
                summary["ok"] = False
                summary["cleanup_mcp_error"] = str(error)
        if fixture is not None and fixture.poll() is None:
            fixture.terminate()
            try:
                fixture.wait(timeout=3)
            except subprocess.TimeoutExpired:
                fixture.kill()
                fixture.wait(timeout=3)
        if watcher is not None and watcher.poll() is None:
            watcher.terminate()
            watcher.wait(timeout=3)
        for handle in (fixture_error, watcher_output, watcher_error):
            if handle is not None:
                handle.close()
        # Review only the interval beginning with the observed OS lock. After
        # that, every known-unlocked sample needs all-display covers + HID tap.
        samples = []
        if (directory / "protection.jsonl").exists():
            for line in (directory / "protection.jsonl").read_text().splitlines():
                try:
                    samples.append(json.loads(line))
                except json.JSONDecodeError:
                    summary["ok"] = False
                    summary["probe_error"] = "Truncated protection sample"
        first_lock = next((index for index, row in enumerate(samples) if row.get("known") and
                           (row.get("osLocked") or row.get("osLockedAtStart") is True)), None)
        if first_lock is not None:
            interval = samples[first_lock:]
            failures = []
            for row in interval:
                reason = None
                if not row.get("known"):
                    reason = "unknown_lock_state"
                elif not row.get("osLocked") and not row.get("protectionVerified"):
                    # A true -> false transition is NOT an exception: at the
                    # end of this sample the desktop was unlocked and the
                    # independent observations did not verify a complete guard.
                    reason = "unlocked_at_end_without_verified_protection"
                elif row.get("osLockedAtStart") is False and not row.get("protectionVerified"):
                    # This can be a non-atomic observation during legitimate
                    # relocking. Keep it as an unverified interval, rather than
                    # claiming continuous protection without evidence.
                    reason = "unlocked_at_start_relock_interval_unverified"
                if reason is not None:
                    failures.append({**row, "auditReason": reason})
            summary["protection_samples"] = len(interval)
            summary["protection_failures"] = failures
            summary["lock_transition_samples"] = [row for row in interval if
                row.get("osLockedAtStart") is not None and row["osLockedAtStart"] != row.get("osLocked")]
            protected_samples = [row for row in interval if not row.get("osLocked") and row.get("protectionVerified")]
            summary["guarded_unlocked_samples"] = len(protected_samples)
            summary["watchdog_only_unlocked_samples"] = sum(
                watchdog in row.get("protectingPIDs", []) and guardian not in row.get("protectingPIDs", []) for row in protected_samples)
            gaps = [later["uptime"] - earlier["uptime"] for earlier, later in zip(interval, interval[1:])]
            summary["max_probe_gap_seconds"] = max(gaps, default=0)
            if summary["ok"] and (len(protected_samples) < 3 or max(gaps, default=0) > 1.5):
                summary["ok"] = False
                summary["probe_error"] = "Insufficient continuous protection samples"
            if failures:
                summary["ok"] = False
        elif lock_requested:
            summary["ok"] = False
            summary["probe_error"] = "The independent sampler never saw an OS lock"
        (directory / "stopped").unlink(missing_ok=True)
        summary["finished"] = time.time()
        evidence.record("finished", ok=summary["ok"])
        evidence.events.close()
        (directory / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if summary["ok"] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("binary", nargs="?", type=Path, default=INSTALLED)
    parser.add_argument("--lock", action="store_true", help="Explicitly perform a real OS lock; finishes locked and never manually unlocks")
    parser.add_argument("--case", choices=("end", "parent-crash", "guardian-crash", "hid"), default="end")
    options = parser.parse_args()
    options.binary = options.binary.expanduser().resolve()
    preflight = installation_check(options.binary)
    if not options.lock or not preflight["ready"]:
        print(json.dumps({"mode": "read-only preflight", **preflight,
                          "next": "Use --lock to run a case while the owner has manually unlocked the Mac."}, ensure_ascii=False, indent=2))
        return 0 if preflight["ready"] else 1
    return run_locked(options, preflight)


if __name__ == "__main__":
    raise SystemExit(main())
