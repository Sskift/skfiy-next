// Feasibility experiment for keyboard input to a multi-window app while
// macOS is locked (scripts/experiment_locked_keyboard.py). Never activates
// anything; posts events only to the given test process.
//
//   KeyboardProbe signals <pid>                         what could tell the receiving window
//   KeyboardProbe send <pid> <variant> <window> <char>  plain | routed | focus | focus-routed
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

func output(_ value: Any) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data([10]))
}

private let handle = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY)
func symbol<T>(_ name: String, _ type: T.Type) -> T? {
    dlsym(UnsafeMutableRawPointer(bitPattern: -2), name).map { unsafeBitCast($0, to: type) }
}
typealias PostToPid = @convention(c) (pid_t, CGEvent) -> Void
typealias SetIntegerField = @convention(c) (CGEvent, UInt32, Int64) -> Void
typealias PostEventRecord = @convention(c) (UnsafeRawPointer, UnsafePointer<UInt8>) -> Int32
typealias ProcessForPID = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Int32
typealias AXGetWindow = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
let postToPid = symbol("SLEventPostToPid", PostToPid.self)
let setField = symbol("SLEventSetIntegerValueField", SetIntegerField.self)
let postRecord = symbol("SLPSPostEventRecordTo", PostEventRecord.self)
let processForPID = symbol("GetProcessForPID", ProcessForPID.self)
let axGetWindow = symbol("_AXUIElementGetWindow", AXGetWindow.self)

func windowID(_ element: AXUIElement?) -> Int? {
    guard let element, let axGetWindow else { return nil }
    var id: CGWindowID = 0
    return axGetWindow(element, &id) == .success && id != 0 ? Int(id) : nil
}

func axElement(_ app: AXUIElement, _ attribute: String) -> AXUIElement? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, attribute as CFString, &value) == .success, let value,
          CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func signals(_ pid: pid_t) -> [String: Any] {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1)
    var windows: CFTypeRef?
    AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windows)
    let axWindows = ((windows as? [AXUIElement]) ?? []).compactMap(windowID)
    let cg = (CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? [])
        .filter { $0[kCGWindowOwnerPID as String] as? Int == Int(pid) && $0[kCGWindowLayer as String] as? Int == 0 }
        .filter { (($0[kCGWindowBounds as String] as? [String: Double])?["Width"] ?? 0) >= 100 }
        .compactMap { $0[kCGWindowNumber as String] as? Int }
    var active: [Int] = []
    let done = DispatchSemaphore(value: 0)
    Task.detached {
        if let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false) {
            active = content.windows.filter { $0.owningApplication?.processID == pid && $0.isActive && $0.frame.width >= 100 }.map { Int($0.windowID) }
        }
        done.signal()
    }
    _ = done.wait(timeout: .now() + 3)
    return ["axFocused": windowID(axElement(app, kAXFocusedWindowAttribute)) as Any,
            "axMain": windowID(axElement(app, kAXMainWindowAttribute)) as Any,
            "axWindows": axWindows, "cgOrder": cg, "sckActive": active.sorted()]
}

func focusRecord(_ window: CGWindowID, focus: Bool) -> [UInt8] {
    var bytes = [UInt8](repeating: 0, count: 0xF8)
    bytes[0x04] = 0xF8
    bytes[0x08] = 0x0D
    withUnsafeBytes(of: window.littleEndian) { raw in for i in 0..<4 { bytes[0x3C + i] = raw[i] } }
    bytes[0x8A] = focus ? 0x01 : 0x02
    return bytes
}

func send(_ pid: pid_t, variant: String, window: CGWindowID, character: String) -> [String: Any] {
    var result: [String: Any] = ["variant": variant]
    if variant.hasPrefix("focus") {
        var psn = [UInt8](repeating: 0, count: 8)
        if let processForPID, let postRecord, processForPID(pid, &psn) == 0 {
            result["focusStatus"] = Int(postRecord(psn, focusRecord(window, focus: true)))
            usleep(80_000)
        } else {
            result["focusStatus"] = "unavailable"
        }
    }
    let source = CGEventSource(stateID: .privateState)
    let units = Array(character.utf16)
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { continue }
        event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        if variant.hasSuffix("routed") {
            for field: UInt32 in [51, 91, 92] {
                if let setField { setField(event, field, Int64(window)) } else { event.setIntegerValueField(CGEventField(rawValue: field)!, value: Int64(window)) }
            }
            if let postToPid { postToPid(pid, event) } else { event.postToPid(pid) }
        } else {
            event.postToPid(pid)
        }
        usleep(5_000)
    }
    return result
}

let arguments = Array(CommandLine.arguments.dropFirst())
switch arguments.first {
case "signals" where arguments.count == 2: output(signals(pid_t(arguments[1])!))
case "send" where arguments.count == 5:
    output(send(pid_t(arguments[1])!, variant: arguments[2], window: CGWindowID(arguments[3])!, character: arguments[4]))
default:
    FileHandle.standardError.write(Data("usage: KeyboardProbe signals <pid> | send <pid> <plain|routed|focus|focus-routed> <window> <char>\n".utf8))
    exit(2)
}
