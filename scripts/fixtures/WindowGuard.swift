// Keeps test windows from covering the user's: while it runs, whenever a
// window of one of the named test apps is the topmost normal window although
// another app is frontmost, the frontmost app's own top window is raised back
// over it (accessibility raise of a window of the already active app: no
// activation, no focus change). Prints one JSON line per correction.
//
//   WindowGuard <owner name or pid>...      runs until killed
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
let watched = Set(CommandLine.arguments.dropFirst())
guard !watched.isEmpty else {
    FileHandle.standardError.write(Data("usage: WindowGuard <owner name or pid>...\n".utf8))
    exit(2)
}

typealias GetWindow = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
let getWindow = dlsym(dlopen(nil, RTLD_NOW), "_AXUIElementGetWindow").map { unsafeBitCast($0, to: GetWindow.self) }

func windowID(_ element: AXUIElement) -> CGWindowID? {
    var id: CGWindowID = 0
    return getWindow?(element, &id) == .success ? id : nil
}

func raise(_ id: CGWindowID, of pid: pid_t) -> Bool {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.5)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
          let windows = value as? [AXUIElement],
          let window = windows.first(where: { windowID($0) == id }) else { return false }
    return AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success
}

func isWatched(_ row: [String: Any]) -> Bool {
    let name = row[kCGWindowOwnerName as String] as? String ?? ""
    let pid = row[kCGWindowOwnerPID as String] as? Int ?? 0
    return watched.contains(name) || watched.contains(String(pid))
}

var lastFix = Date.distantPast
while true {
    autoreleasepool {
        guard let front = NSWorkspace.shared.frontmostApplication?.processIdentifier else { return }
        let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let normal = rows.filter { row in
            guard (row[kCGWindowLayer as String] as? Int) == 0, ((row[kCGWindowAlpha as String] as? Double) ?? 1) > 0.01,
                  let bounds = row[kCGWindowBounds as String] as? [String: Double] else { return false }
            return (bounds["Width"] ?? 0) >= 80 && (bounds["Height"] ?? 0) >= 80
        }
        guard let top = normal.first, (top[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) != front, isWatched(top),
              let mine = normal.first(where: { ($0[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == front }),
              let id = mine[kCGWindowNumber as String] as? UInt32 else { return }
        let raised = raise(id, of: front)
        let row: [String: Any] = ["time": Date().timeIntervalSince1970, "intruder": top[kCGWindowOwnerName as String] as? String ?? "?",
                                  "intruderWindow": top[kCGWindowNumber as String] as? Int ?? 0, "raised": raised,
                                  "front": NSWorkspace.shared.frontmostApplication?.localizedName ?? "?"]
        if Date().timeIntervalSince(lastFix) > 0.2 || !raised {
            print(String(decoding: try! JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]), as: UTF8.self))
        }
        lastFix = Date()
    }
    usleep(30_000)
}
