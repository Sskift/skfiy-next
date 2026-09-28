import AppKit
import CoreGraphics
// Every 0.25 s: time, front app, owner of the topmost normal window, seconds since the user's last input.
setvbuf(stdout, nil, _IOLBF, 0)
let anyInput = CGEventType(rawValue: UInt32.max)!
while true {
    let front = NSWorkspace.shared.frontmostApplication?.localizedName ?? "?"
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let top = windows.first { info in
        guard (info[kCGWindowLayer as String] as? Int) == 0, ((info[kCGWindowAlpha as String] as? Double) ?? 1) > 0.01 else { return false }
        let bounds = info[kCGWindowBounds as String] as? [String: Double] ?? [:]
        return (bounds["Width"] ?? 0) > 80 && (bounds["Height"] ?? 0) > 80
    }
    let owner = top?[kCGWindowOwnerName as String] as? String ?? "?"
    let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyInput)
    print(String(format: "%.2f\t%@\t%@\t%.1f", Date().timeIntervalSince1970, front, owner, idle))
    RunLoop.current.run(until: Date().addingTimeInterval(0.25))
}
