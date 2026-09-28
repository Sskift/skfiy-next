import AppKit
import CoreGraphics
// Every 0.25 s: time, front app, owner of the topmost normal window, seconds since the user's last
// click or modifier press, and the owners of menus and floating panels on screen.
setvbuf(stdout, nil, _IOLBF, 0)
while true {
    let front = NSWorkspace.shared.frontmostApplication?.localizedName ?? "?"
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let top = windows.first { info in
        guard (info[kCGWindowLayer as String] as? Int) == 0, ((info[kCGWindowAlpha as String] as? Double) ?? 1) > 0.01 else { return false }
        let bounds = info[kCGWindowBounds as String] as? [String: Double] ?? [:]
        return (bounds["Width"] ?? 0) > 80 && (bounds["Height"] ?? 0) > 80
    }
    let owner = top?[kCGWindowOwnerName as String] as? String ?? "?"
    // Menus and floating panels (layers between normal windows and the screen saver).
    let overlays = Set(windows.compactMap { info -> String? in
        guard let layer = info[kCGWindowLayer as String] as? Int, layer > 0, layer < 1000 else { return nil }
        return info[kCGWindowOwnerName as String] as? String
    }).sorted().joined(separator: ",")
    // Only clicks and modifier presses can switch apps; typing cannot.
    let idle = [CGEventType.flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown]
        .map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? 0
    print(String(format: "%.2f\t%@\t%@\t%.1f\t%@", Date().timeIntervalSince1970, front, owner, idle, overlays))
    RunLoop.current.run(until: Date().addingTimeInterval(0.25))
}
