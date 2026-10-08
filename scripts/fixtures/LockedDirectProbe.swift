// Standalone diagnostic only (scripts/diagnose_locked_direct.py). Every
// input/capture targets a dedicated fixture (scripts/fixtures/LockedFixture.swift).
// No unlock action, authorization request, authdb write or product-gate change.
//
//   LockedDirectProbe sample | watch    the OS lock state, once or every 50 ms
//   LockedDirectProbe lock              asks macOS to lock now and waits until it is
//   LockedDirectProbe <op> STATE EXECUTABLE NONCE [VALUE | OUT.png]
//     ax-read          the fixture's nonce field, read through accessibility
//     ax-write-press   VALUE set into that field and Commit pressed, through accessibility
//     key | mouse      a letter, or a click on its canvas, posted to the fixture's pid
//     capture          its window captured (ScreenCaptureKit) to OUT.png, and OCR
//   STATE is the fixture's state file, EXECUTABLE its binary, NONCE the run's; any
//   other target is refused. Prints one JSON object per line.
import AppKit
import ApplicationServices
import Darwin
import Foundation
import ImageIO
import ScreenCaptureKit
import Vision

struct Failure: Error, CustomStringConvertible {
    let description: String
    init(_ text: String) { description = text }
}
func emit(_ row: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data([10]))
}
func lockState() -> [String: Any] {
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    let known = session != nil && session?["kCGSSessionOnConsoleKey"] as? Bool == true
        && session?["kCGSessionLoginDoneKey"] as? Bool == true
    return ["timestamp": Date().timeIntervalSince1970, "uptime": ProcessInfo.processInfo.systemUptime,
            "known": known, "locked": session?["CGSSessionScreenIsLocked"] as? Bool ?? false,
            "axTrusted": AXIsProcessTrusted(), "screenCapture": CGPreflightScreenCaptureAccess()]
}
func loadState(_ path: String) throws -> [String: Any] {
    guard let value = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: Any] else {
        throw Failure("Fixture state is not a dictionary")
    }
    return value
}
func attribute(_ item: AXUIElement, _ name: String) -> (AXError, CFTypeRef?) {
    var result: CFTypeRef?
    let code = AXUIElementCopyAttributeValue(item, name as CFString, &result)
    return (code, result)
}
func find(_ root: AXUIElement, identifier: String, budget: inout Int) -> AXUIElement? {
    guard budget > 0 else { return nil }; budget -= 1
    if attribute(root, "AXIdentifier").1 as? String == identifier { return root }
    for child in (attribute(root, kAXChildrenAttribute).1 as? [AXUIElement] ?? []) {
        if let value = find(child, identifier: identifier, budget: &budget) { return value }
    }
    return nil
}
@MainActor func perform(_ args: [String]) async throws {
    guard let mode = args.first else { throw Failure("Missing mode") }
    if mode == "sample" { emit(lockState()); return }
    if mode == "watch" {
        while true { emit(lockState()); try await Task.sleep(nanoseconds: 50_000_000) }
    }
    if mode == "lock" {
        guard let handle = dlopen("/System/Library/PrivateFrameworks/login.framework/Versions/Current/login", RTLD_NOW),
              let symbol = dlsym(handle, "SACLockScreenImmediate") else { throw Failure("OS lock API unavailable") }
        typealias Lock = @convention(c) () -> Void
        unsafeBitCast(symbol, to: Lock.self)()
        // The request is asynchronous: keep the event loop alive and verify
        // the OS state instead of interpreting an undocumented return value.
        let deadline = ProcessInfo.processInfo.systemUptime + 6
        while ProcessInfo.processInfo.systemUptime < deadline {
            let state = lockState()
            if state["known"] as? Bool == true, state["locked"] as? Bool == true {
                emit(["confirmedLocked": true, "state": state]); return
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw Failure("OS did not confirm a locked session after the lock request")
    }
    guard args.count >= 4 else { throw Failure("Expected mode STATE EXPECTED_EXECUTABLE RUN_NONCE [VALUE]") }
    let state = try loadState(args[1])
    guard state["run_nonce"] as? String == args[3], let pidValue = state["pid"] as? Int,
          let window = state["window_id"] as? Int, pidValue > 1, window > 0 else { throw Failure("Fixture identity absent") }
    let pid = pid_t(pidValue)
    guard let running = NSRunningApplication(processIdentifier: pid),
          running.executableURL?.standardizedFileURL.path == URL(fileURLWithPath: args[2]).standardizedFileURL.path,
          running.bundleIdentifier == "com.skfiy.lockedfixture.\(args[3])" else { throw Failure("Target is not this run's fixture") }
    let before = lockState()
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.8)
    var report: [String: Any] = ["mode": mode, "pid": pidValue, "windowID": window, "before": before]
    if mode == "ax-read" || mode == "ax-write-press" {
        var budget = 100
        let input = find(app, identifier: "fixture-nonce", budget: &budget)
        budget = 100
        let button = find(app, identifier: "fixture-commit", budget: &budget)
        report["inputFound"] = input != nil; report["buttonFound"] = button != nil
        report["rootRoleCode"] = attribute(app, kAXRoleAttribute).0.rawValue
        if let input {
            let read = attribute(input, kAXValueAttribute)
            report["readCode"] = read.0.rawValue; report["value"] = read.1 as? String ?? ""
        }
        if mode == "ax-write-press", let input, let button, args.count > 4 {
            report["setCode"] = AXUIElementSetAttributeValue(input, kAXValueAttribute as CFString, args[4] as CFString).rawValue
            report["pressCode"] = AXUIElementPerformAction(button, kAXPressAction as CFString).rawValue
        }
    } else if mode == "key" {
        // A normal letter, exclusively to the fixture. Never Return or loginwindow.
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: CGEventSource(stateID: .privateState), virtualKey: 0, keyDown: down) else {
                throw Failure("Cannot allocate key event")
            }
            event.flags = []
            event.postToPid(pid)
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        report["posted"] = true
    } else if mode == "mouse" {
        guard let frames = state["frames"] as? [String: [String: Double]], let frame = frames["canvas"],
              let x = frame["x"], let y = frame["y"], let width = frame["width"], let height = frame["height"] else {
            throw Failure("Missing fixture canvas geometry")
        }
        let point = CGPoint(x: x + width * 0.25, y: y + height * 0.5)
        let source = CGEventSource(stateID: .hidSystemState)
        // Exact process/window routing fields used by the product's background input.
        for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
            guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else {
                throw Failure("Cannot allocate pointer event")
            }
            event.flags = []
            for (field, value): (UInt32, Int64) in [(0, 3), (1, type == .mouseMoved ? 0 : 1), (3, 0), (7, 3),
                                                  (40, Int64(pid)), (51, Int64(window)), (58, 1), (91, Int64(window)), (92, Int64(window))] {
                if let key = CGEventField(rawValue: field) { event.setIntegerValueField(key, value: value) }
            }
            event.postToPid(pid)
            try await Task.sleep(nanoseconds: 30_000_000)
        }
        report["posted"] = true; report["point"] = ["x": point.x, "y": point.y]
    } else if mode == "capture" {
        guard args.count > 4 else { throw Failure("Capture needs output PNG") }
        // Main actor and initialized AppKit. Only the verified fixture window is captured.
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        guard let target = content.windows.first(where: { $0.windowID == CGWindowID(window) && $0.owningApplication?.processID == pid }) else {
            throw Failure("Fixture window absent from ScreenCaptureKit shareable content")
        }
        let filter = SCContentFilter(desktopIndependentWindow: target)
        let config = SCStreamConfiguration()
        config.width = max(1, Int(target.frame.width * 2)); config.height = max(1, Int(target.frame.height * 2))
        config.showsCursor = false; config.captureResolution = .best
        let picture = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let url = URL(fileURLWithPath: args[4])
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
            throw Failure("Cannot open PNG destination")
        }
        CGImageDestinationAddImage(destination, picture, nil)
        guard CGImageDestinationFinalize(destination) else { throw Failure("Cannot save PNG") }
        let ocr = VNRecognizeTextRequest(); ocr.recognitionLevel = .accurate; ocr.usesLanguageCorrection = false
        ocr.recognitionLanguages = ["en-US"]
        try VNImageRequestHandler(cgImage: picture).perform([ocr])
        report["lines"] = ocr.results?.compactMap { $0.topCandidates(1).first?.string } ?? []
        report["width"] = picture.width; report["height"] = picture.height
        report["path"] = url.path
    } else { throw Failure("Unknown operation") }
    report["after"] = lockState(); emit(report)
}
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
Task { @MainActor in
    do { try await perform(Array(CommandLine.arguments.dropFirst())); exit(0) }
    catch { emit(["error": String(describing: error), "state": lockState()]); exit(1) }
}
application.run()
