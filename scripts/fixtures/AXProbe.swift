// Independent verifier for the compatibility tests: reads an app's windows,
// sheets, focused text and selected rows through accessibility and the
// window server, never through skfiy. Read only; prints one JSON object.
//
//   AXProbe dump <pid>     windows (AX + CG), sheets with their buttons, focused element, selected rows
//   AXProbe perwindow <pid> each window by id: its text, selection, scroll bars; the key and main window
//   AXProbe instances <bundle id>   every process of an app: pid, activation policy, window count
//   AXProbe attribute <pid> <name>  one attribute of the application element
//   AXProbe front          the frontmost app and the owner of the top normal window
//   AXProbe session        whether the console session is locked, and the user's idle seconds
//   AXProbe displays       the online displays (global top-left points) and their pixels per point
//   AXProbe windows <pid>  the window server's frames of an app's windows
//   AXProbe ocr <image>    text recognized in an image file (Vision, accurate)
//   AXProbe red <image>    the centre of the image's strongly red pixels, in its pixels
import AppKit
import ImageIO
import Vision
import ApplicationServices
import CoreGraphics
import Foundation

func output(_ value: Any) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data([10]))
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func string(_ element: AXUIElement, _ name: String) -> String? {
    guard let value = attribute(element, name) else { return nil }
    if let text = value as? String { return text }
    if let number = value as? NSNumber { return number.stringValue }
    if let attributed = value as? NSAttributedString { return attributed.string }
    return nil
}

func elements(_ element: AXUIElement, _ name: String) -> [AXUIElement] {
    (attribute(element, name) as? [AXUIElement]) ?? []
}

func element(_ element: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func frame(_ element: AXUIElement) -> [String: Double]? {
    guard let position = attribute(element, kAXPositionAttribute), let size = attribute(element, kAXSizeAttribute) else { return nil }
    var point = CGPoint.zero, extent = CGSize.zero
    AXValueGetValue(position as! AXValue, .cgPoint, &point)
    AXValueGetValue(size as! AXValue, .cgSize, &extent)
    return ["x": point.x, "y": point.y, "width": extent.width, "height": extent.height]
}

func range(_ element: AXUIElement) -> [String: Int]? {
    guard let value = attribute(element, kAXSelectedTextRangeAttribute) else { return nil }
    var selection = CFRange()
    guard AXValueGetValue(value as! AXValue, .cfRange, &selection) else { return nil }
    return ["location": selection.location, "length": selection.length]
}

/// Breadth-first search, bounded so a huge tree cannot hang the probe.
func search(_ root: AXUIElement, budget: Int = 4000, where matches: (AXUIElement, String) -> Bool) -> [AXUIElement] {
    var queue = [root], found: [AXUIElement] = [], visited = 0
    while !queue.isEmpty, visited < budget {
        let next = queue.removeFirst()
        visited += 1
        let role = string(next, kAXRoleAttribute) ?? ""
        if matches(next, role) { found.append(next) }
        queue.append(contentsOf: elements(next, kAXChildrenAttribute))
    }
    return found
}

func dump(_ pid: pid_t) -> [String: Any] {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 3)
    let focusedWindow = element(app, kAXFocusedWindowAttribute)
    var windows: [[String: Any]] = []
    for window in elements(app, kAXWindowsAttribute) {
        let sheets = elements(window, kAXChildrenAttribute).filter { string($0, kAXRoleAttribute) == "AXSheet" }
        let sheetInfo = sheets.map { sheet -> [String: Any] in
            let buttons = search(sheet, budget: 400) { _, role in role == "AXButton" }.compactMap { string($0, kAXTitleAttribute) }
            let texts = search(sheet, budget: 400) { _, role in role == "AXStaticText" || role == "AXTextField" }
                .compactMap { string($0, kAXValueAttribute) }
            return ["buttons": buttons, "texts": texts]
        }
        var row: [String: Any] = [
            "title": string(window, kAXTitleAttribute) ?? "",
            "role": string(window, kAXRoleAttribute) ?? "",
            "subrole": string(window, kAXSubroleAttribute) ?? "",
            "minimized": string(window, kAXMinimizedAttribute) == "1",
            "focused": focusedWindow.map { CFEqual($0, window) } ?? false,
            "sheets": sheetInfo
        ]
        if let frame = frame(window) { row["frame"] = frame }
        if let document = string(window, kAXDocumentAttribute) { row["document"] = document }
        windows.append(row)
    }
    var result: [String: Any] = ["pid": Int(pid), "windows": windows]
    if let focused = element(app, kAXFocusedUIElementAttribute) {
        var info: [String: Any] = ["role": string(focused, kAXRoleAttribute) ?? ""]
        if let value = string(focused, kAXValueAttribute) { info["value"] = String(value.prefix(20000)) }
        if let selection = range(focused) { info["selection"] = selection }
        result["focused"] = info
    }
    if let window = focusedWindow {
        // Text areas (TextEdit), selected rows (Finder) and scroll positions.
        let areas = search(window) { _, role in role == "AXTextArea" }
        result["textAreas"] = areas.prefix(3).map { area -> [String: Any] in
            var info: [String: Any] = ["value": String((string(area, kAXValueAttribute) ?? "").prefix(20000))]
            if let selection = range(area) { info["selection"] = selection }
            return info
        }
        let rows = search(window) { candidate, role in role == "AXRow" && string(candidate, kAXSelectedAttribute) == "1" }
        result["selectedRows"] = rows.map { row -> String in
            let cells = search(row, budget: 50) { _, role in role == "AXTextField" || role == "AXStaticText" }
            return cells.compactMap { string($0, kAXValueAttribute) }.first ?? string(row, kAXDescriptionAttribute) ?? ""
        }
        let bars = search(window) { _, role in role == "AXScrollBar" }
        result["scrollBars"] = bars.compactMap { bar -> [String: Any]? in
            guard let value = attribute(bar, kAXValueAttribute) as? NSNumber else { return nil }
            return ["orientation": string(bar, kAXOrientationAttribute) ?? "", "value": value.doubleValue]
        }
    }
    let cg = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    result["cgWindows"] = cg.filter { ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) && ($0[kCGWindowLayer as String] as? Int) == 0 }
        .compactMap { row -> [String: Any]? in
            guard let bounds = row[kCGWindowBounds as String] as? [String: Double], (bounds["Width"] ?? 0) >= 40 else { return nil }
            return ["id": row[kCGWindowNumber as String] as? Int ?? 0, "title": row[kCGWindowName as String] as? String ?? "",
                    "onscreen": row[kCGWindowIsOnscreen as String] as? Bool ?? false, "bounds": bounds]
        }
    return result
}

func front() -> [String: Any] {
    let app = NSWorkspace.shared.frontmostApplication
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let top = windows.first { info in
        guard (info[kCGWindowLayer as String] as? Int) == 0, ((info[kCGWindowAlpha as String] as? Double) ?? 1) > 0.01 else { return false }
        let bounds = info[kCGWindowBounds as String] as? [String: Double] ?? [:]
        return (bounds["Width"] ?? 0) > 80 && (bounds["Height"] ?? 0) > 80
    }
    return ["front": app?.localizedName ?? "?", "frontPID": Int(app?.processIdentifier ?? 0),
            "topOwner": top?[kCGWindowOwnerName as String] as? String ?? "?",
            "topWindow": top?[kCGWindowNumber as String] as? Int ?? 0]
}

func session() -> [String: Any] {
    let dictionary = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
    let known = dictionary["kCGSSessionOnConsoleKey"] as? Bool == true && dictionary["kCGSessionLoginDoneKey"] as? Bool == true
    let idle = [CGEventType.keyDown, .leftMouseDown, .rightMouseDown, .mouseMoved, .scrollWheel, .flagsChanged]
        .map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? 0
    // Window capture needs the display on; record whether it was asleep.
    // idleSeconds counts the user's own keys, clicks, moves and scrolls. Not
    // "any event" of the HID state: skfiy's mouse events come from that state's
    // source and reset it (and IOHIDSystem's HIDIdleTime) without anyone there.
    return ["known": known, "locked": dictionary["CGSSessionScreenIsLocked"] as? Bool == true, "idleSeconds": idle,
            "displayAsleep": CGDisplayIsAsleep(CGMainDisplayID()) != 0,
            "accessibility": AXIsProcessTrusted(), "screenCapture": CGPreflightScreenCaptureAccess(), "timestamp": Date().timeIntervalSince1970]
}

/// Online displays in global top-left points, with their pixels per point.
func displays() -> [String: Any] {
    var ids = [CGDirectDisplayID](repeating: 0, count: 16)
    var count: UInt32 = 0
    _ = CGGetOnlineDisplayList(16, &ids, &count)
    return ["displays": ids.prefix(Int(count)).map { id -> [String: Any] in
        let bounds = CGDisplayBounds(id)
        let mode = CGDisplayCopyDisplayMode(id)
        return ["id": Int(id), "x": bounds.minX, "y": bounds.minY, "width": bounds.width, "height": bounds.height,
                "scale": mode.map { Double($0.pixelWidth) / Double(max($0.width, 1)) } ?? 0,
                "main": CGDisplayIsMain(id) != 0, "asleep": CGDisplayIsAsleep(id) != 0]
    }]
}

/// The window server's frames of an app's windows (global top-left points):
/// what is on screen, even before the app itself hears its windows moved.
func windows(_ pid: pid_t) -> [String: Any] {
    let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
    return ["windows": list.compactMap { info -> [String: Any]? in
        guard info[kCGWindowOwnerPID as String] as? Int == Int(pid), info[kCGWindowLayer as String] as? Int == 0,
              let bounds = info[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: bounds) else { return nil }
        return ["id": info[kCGWindowNumber as String] as? Int ?? 0, "x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height,
                "onScreen": info[kCGWindowIsOnscreen as String] as? Bool ?? false]
    }]
}

typealias GetWindowID = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
let getWindowID = dlsym(dlopen(nil, RTLD_NOW), "_AXUIElementGetWindow").map { unsafeBitCast($0, to: GetWindowID.self) }

func windowNumber(_ window: AXUIElement?) -> Int {
    guard let window else { return 0 }
    var id: CGWindowID = 0
    return getWindowID?(window, &id) == .success ? Int(id) : 0
}

/// Each window on its own, by id: its text (value length, start and end,
/// selection), scroll bars, whether it is minimized; and which window is the
/// app's key (focused) and main window, and holds the focused element.
func perWindow(_ pid: pid_t) -> [String: Any] {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 3)
    var result: [String: Any] = ["pid": Int(pid), "focusedWindow": windowNumber(element(app, kAXFocusedWindowAttribute)),
                                 "mainWindow": windowNumber(element(app, kAXMainWindowAttribute)),
                                 "hidden": string(app, kAXHiddenAttribute) == "1"]
    if let focused = element(app, kAXFocusedUIElementAttribute) {
        result["focusedElementWindow"] = windowNumber(element(focused, kAXWindowAttribute))
        result["focusedElementRole"] = string(focused, kAXRoleAttribute) ?? ""
    }
    result["windows"] = elements(app, kAXWindowsAttribute).filter { string($0, kAXRoleAttribute) == kAXWindowRole }.map { window -> [String: Any] in
        let texts = search(window, budget: 3000) { _, role in role == "AXTextArea" || role == "AXTextField" }.prefix(4).map { text -> [String: Any] in
            let value = string(text, kAXValueAttribute) ?? ""
            var info: [String: Any] = ["role": string(text, kAXRoleAttribute) ?? "", "label": string(text, kAXDescriptionAttribute) ?? "",
                                       "length": (value as NSString).length, "head": String(value.prefix(60)), "tail": String(value.suffix(60)),
                                       "focused": string(text, kAXFocusedAttribute) == "1"]
            if let selection = range(text) { info["selection"] = selection }
            return info
        }
        let bars = search(window, budget: 3000) { _, role in role == "AXScrollBar" }.compactMap { (attribute($0, kAXValueAttribute) as? NSNumber)?.doubleValue }
        return ["id": windowNumber(window), "title": string(window, kAXTitleAttribute) ?? "", "minimized": string(window, kAXMinimizedAttribute) == "1",
                "texts": Array(texts), "scroll": bars]
    }
    return result
}

/// Every process of an app (by bundle id): its pid, activation policy and
/// how many windows accessibility lists for it.
func instances(_ bundleID: String) -> [String: Any] {
    let policies: [NSApplication.ActivationPolicy: String] = [.regular: "regular", .accessory: "accessory", .prohibited: "prohibited"]
    return ["instances": NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier?.lowercased() == bundleID.lowercased() }.map { app -> [String: Any] in
        let element = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(element, 2)
        return ["pid": Int(app.processIdentifier), "policy": policies[app.activationPolicy] ?? "?", "active": app.isActive,
                "windows": elements(element, kAXWindowsAttribute).count]
    }]
}

/// One attribute of an app's application element (e.g. AXEnhancedUserInterface).
func appAttribute(_ pid: pid_t, _ name: String) -> [String: Any] {
    let element = AXUIElementCreateApplication(pid)
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return ["status": Int(status.rawValue), "value": (value as? NSNumber)?.intValue ?? (value as? String) ?? NSNull()]
}

/// On-screen normal windows (layer 0), front to back.
func stack() -> [String: Any] {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return ["windows": list.compactMap { info -> [String: Any]? in
        guard info[kCGWindowLayer as String] as? Int == 0, let bounds = info[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: bounds) else { return nil }
        return ["id": info[kCGWindowNumber as String] as? Int ?? 0, "pid": info[kCGWindowOwnerPID as String] as? Int ?? 0,
                "owner": info[kCGWindowOwnerName as String] as? String ?? "", "alpha": info[kCGWindowAlpha as String] as? Double ?? 1,
                "x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]
    }]
}

/// The mean colour (0-255) of a rectangle of an image, in its pixels.
func patch(_ path: String, _ rect: CGRect) -> [String: Any] {
    guard let image = image(path) else { return ["error": "cannot decode"] }
    let width = image.width, height = image.height
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    guard let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return ["error": "context"] }
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    var sum = [0.0, 0.0, 0.0], count = 0.0
    for y in max(0, Int(rect.minY))..<min(height, Int(rect.maxY)) {
        for x in max(0, Int(rect.minX))..<min(width, Int(rect.maxX)) {
            let i = (y * width + x) * 4
            for c in 0..<3 { sum[c] += Double(pixels[i + c]) }
            count += 1
        }
    }
    return count == 0 ? ["error": "empty"] : ["r": sum[0] / count, "g": sum[1] / count, "b": sum[2] / count]
}

func image(_ path: String) -> CGImage? {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(source, 0, nil)
}

func ocr(_ path: String) -> [String: Any] {
    guard let image = image(path) else { return ["error": "cannot decode"] }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    try? VNImageRequestHandler(cgImage: image).perform([request])
    return ["width": image.width, "height": image.height,
            "lines": request.results?.compactMap { $0.topCandidates(1).first?.string } ?? []]
}

func red(_ path: String) -> [String: Any] {
    guard let image = image(path) else { return ["error": "cannot decode"] }
    let width = image.width, height = image.height
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    guard let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return ["error": "context"] }
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    var sx = 0.0, sy = 0.0, count = 0
    for y in 0..<height {
        for x in 0..<width {
            let i = (y * width + x) * 4
            if pixels[i] > 180, pixels[i + 1] < 110, pixels[i + 2] < 110 { sx += Double(x) + 0.5; sy += Double(y) + 0.5; count += 1 }
        }
    }
    return count == 0 ? ["count": 0, "width": width, "height": height]
        : ["count": count, "x": sx / Double(count), "y": sy / Double(count), "width": width, "height": height]
}

let arguments = Array(CommandLine.arguments.dropFirst())
switch arguments.first {
case "dump" where arguments.count == 2 && pid_t(arguments[1]) != nil: output(dump(pid_t(arguments[1])!))
case "front": output(front())
case "instances" where arguments.count == 2: output(instances(arguments[1]))
case "attribute" where arguments.count == 3 && pid_t(arguments[1]) != nil: output(appAttribute(pid_t(arguments[1])!, arguments[2]))
case "perwindow" where arguments.count == 2 && pid_t(arguments[1]) != nil: output(perWindow(pid_t(arguments[1])!))
case "stack": output(stack())
case "patch" where arguments.count == 6:
    let numbers: [Double] = arguments[2...5].compactMap { Double($0) }
    if numbers.count == 4 {
        output(patch(arguments[1], CGRect(x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3])))
    } else {
        output(["error": "numbers"])
    }
case "session": output(session())
case "displays": output(displays())
case "windows" where arguments.count == 2 && pid_t(arguments[1]) != nil: output(windows(pid_t(arguments[1])!))
case "ocr" where arguments.count == 2: output(ocr(arguments[1]))
case "red" where arguments.count == 2: output(red(arguments[1]))
default:
    FileHandle.standardError.write(Data("usage: AXProbe dump <pid> | perwindow <pid> | instances <bundle id> | attribute <pid> <name> | front | session | displays | windows <pid> | ocr <image> | red <image>\n".utf8))
    exit(2)
}
