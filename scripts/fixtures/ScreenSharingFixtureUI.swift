// Only for the loopback Screen Sharing fixture. A unique test name or exact
// loopback port is required for every window mutation; no activation or quit.
import AppKit
import ApplicationServices

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func descendants(_ root: AXUIElement) -> [AXUIElement] {
    var elements = [root]
    var index = 0
    while index < elements.count, index < 500 {
        elements += attribute(elements[index], "AXChildren") as? [AXUIElement] ?? []
        index += 1
    }
    return elements
}

func frontPID() -> pid_t {
    // NSWorkspace can retain loginwindow after unlocking; AX reports the
    // current keyboard target and is also what the production guard uses.
    if let focused = attribute(AXUIElementCreateSystemWide(), "AXFocusedApplication"),
       CFGetTypeID(focused) == AXUIElementGetTypeID() {
        var pid: pid_t = 0
        if AXUIElementGetPid(focused as! AXUIElement, &pid) == .success { return pid }
    }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { exit(2) }
if command == "status" {
    let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], 0) as? [[String: Any]] ?? []
    let top = rows.first { ($0[kCGWindowLayer as String] as? Int) == 0 }
    let point = CGEvent(source: nil)?.location ?? .zero
    let state: [String: Any] = [
        "front": Int(frontPID()),
        "topPID": top?[kCGWindowOwnerPID as String] as? Int ?? 0,
        "topWindow": top?[kCGWindowNumber as String] as? Int ?? 0,
        "pointer": [point.x, point.y],
        "clipboard": NSPasteboard.general.changeCount,
    ]
    let data = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
    exit(0)
}

guard args.count >= 2, ["close", "resize"].contains(command) else { exit(2) }
let marker = args[1]
let fixtureName = marker.range(of: "^skfiy Screen Sharing Fixture [0-9a-f]{8}$", options: .regularExpression) != nil
let loopback = marker.range(of: "^127\\.0\\.0\\.1:[0-9]{1,5}$", options: .regularExpression) != nil
guard fixtureName || (command == "close" && loopback) else { exit(2) }
var requestedSize: CGSize?
if command == "resize" {
    guard args.count == 4, let width = Double(args[2]), let height = Double(args[3]),
          (200...2000).contains(width), (200...2000).contains(height) else { exit(2) }
    requestedSize = CGSize(width: width, height: height)
}

for app in NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.ScreenSharing") {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    for window in attribute(root, "AXWindows") as? [AXUIElement] ?? [] {
        let elements = descendants(window)
        let own = elements.contains { element in
            ["AXValue", "AXTitle"].contains { name in
                let text = attribute(element, name) as? String ?? ""
                return fixtureName ? (text == marker || text.hasPrefix(marker + " – ")) : text == marker
            }
        }
        guard own else { continue }
        if command == "close" {
            if let close = attribute(window, "AXCloseButton"), CFGetTypeID(close) == AXUIElementGetTypeID() {
                AXUIElementPerformAction(close as! AXUIElement, "AXPress" as CFString)
            } else if let cancel = elements.first(where: { attribute($0, "AXTitle") as? String == "Cancel" }) {
                AXUIElementPerformAction(cancel, "AXPress" as CFString)
            }
        } else if var size = requestedSize, let value = AXValueCreate(.cgSize, &size) {
            AXUIElementSetAttributeValue(window, "AXSize" as CFString, value)
        }
    }
}
RunLoop.current.run(until: Date().addingTimeInterval(0.5))
