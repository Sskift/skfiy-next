import AppKit
import ApplicationServices

/// AppKit can expose an XPC panel only through focus or an attached sheet,
/// omitting it from AXWindows. Never discover other apps' panels by proximity.
func appWindows(_ app: AXUIElement) -> [AXUIElement] {
    var result = app.elements(kAXWindowsAttribute)
    for attribute in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
        if let window = app.element(attribute), !result.contains(where: { CFEqual($0, window) }) {
            result.append(window)
        }
    }
    var cursor = 0
    while cursor < result.count && cursor < 64 {
        let window = result[cursor]
        cursor += 1
        let attached = window.elements("AXSheets") + window.elements(kAXChildrenAttribute).filter {
            [kAXSheetRole, kAXWindowRole].contains($0.string(kAXRoleAttribute) ?? "")
        }
        for child in attached where !result.contains(where: { CFEqual($0, child) }) { result.append(child) }
    }
    return result
}

/// The WindowServer owner is authoritative for event delivery and capture;
/// AX proxies can still report the host application's PID.
func windowOwner(_ id: CGWindowID) -> pid_t? {
    let rows = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]] ?? []
    return (rows.first?[kCGWindowOwnerPID as String] as? Int).map(pid_t.init)
}
