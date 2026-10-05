// Independent verifier for the compatibility tests: reads an app's windows,
// sheets, focused text and selected rows through accessibility and the
// window server, never through skfiy. Read only; prints one JSON object.
//
//   AXProbe dump <pid>     windows (AX + CG), sheets with their buttons, focused element, selected rows
//   AXProbe front          the frontmost app and the owner of the top normal window
//   AXProbe session        whether the console session is locked, and the user's idle seconds
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
    return ["known": known, "locked": dictionary["CGSSessionScreenIsLocked"] as? Bool == true, "idleSeconds": idle,
            "displayAsleep": CGDisplayIsAsleep(CGMainDisplayID()) != 0,
            "accessibility": AXIsProcessTrusted(), "screenCapture": CGPreflightScreenCaptureAccess(), "timestamp": Date().timeIntervalSince1970]
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
case "session": output(session())
case "ocr" where arguments.count == 2: output(ocr(arguments[1]))
case "red" where arguments.count == 2: output(red(arguments[1]))
default:
    FileHandle.standardError.write(Data("usage: AXProbe dump <pid> | front | session | ocr <image> | red <image>\n".utf8))
    exit(2)
}
