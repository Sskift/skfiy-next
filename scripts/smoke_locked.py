#!/usr/bin/env python3
"""Shared fixture and lock-probe helpers for direct locked-use acceptance.

This is a support module. Run smoke_locked_direct.py or
smoke_locked_direct_multiwindow.py for direct-mode acceptance. These helpers
never install an authorization plugin, lock/unlock macOS, or inject global HID
events.
"""
import json
import plistlib
import subprocess
import time

from harness import ROOT


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
