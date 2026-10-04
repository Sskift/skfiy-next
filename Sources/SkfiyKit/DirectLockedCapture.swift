import CoreGraphics
import Foundation
import ScreenCaptureKit

/// A single app-owned window. Frames use global screen points with a top-left
/// origin, matching CaptureGeometry and PID-targeted input coordinates.
struct DirectLockedWindow: Equatable, Sendable {
    let id: CGWindowID
    let pid: pid_t
    let title: String
    let frame: CGRect
}

/// Enumerates independently capturable windows, including windows hidden by
/// the system lock screen. The caller must pin the running application's
/// identity across this await; a PID alone is not a process-lifetime identity.
@MainActor
func directLockedWindows(pid: pid_t) async throws -> [DirectLockedWindow] {
    try Task.checkCancellation()
    try directLockedCapturePermission()
    guard pid > 0 else { throw ToolError("A running app is required for window capture.") }
    guard let windows = try await withDeadline(3, { @MainActor in
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        let metadata = directLockedWindowMetadata()
        return content.windows.compactMap { directLockedWindow($0, pid: pid, metadata: metadata) }
    }) else {
        throw ToolError("No screenshot: the app's independent window list did not answer within 3 s.")
    }
    try Task.checkCancellation()
    return windows
}

/// Keyboard events target a process, so every active window of that process
/// matters, including floating panels and Stage Manager windows off screen.
/// Inactive AppKit input-method helpers must not count as keyboard targets.
@MainActor
func directLockedActiveWindowIDs(pid: pid_t) async throws -> Set<CGWindowID> {
    try Task.checkCancellation()
    try directLockedCapturePermission()
    guard pid > 0 else { throw ToolError("A running app is required for keyboard window verification.") }
    guard let ids = try await withDeadline(3, { @MainActor in
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        // Do not filter by title, layer, onscreen status or opacity: a real
        // keyboard destination can be untitled, floating, or off screen.
        return Set(content.windows.filter {
            $0.windowID != kCGNullWindowID && $0.owningApplication?.processID == pid && $0.isActive
        }.map(\.windowID))
    }) else {
        throw ToolError("The app's active window list did not answer within 3 s; no keyboard input was sent.")
    }
    try Task.checkCancellation()
    return ids
}

/// Captures exactly the selected window, without switching desktops,
/// unlocking the session, or falling back to a display capture. Fresh SCK
/// objects and matching ownership are required for each screenshot.
@MainActor
func captureDirectLockedWindow(_ window: DirectLockedWindow, maxScale: Double = 1) async throws -> Screenshot {
    try Task.checkCancellation()
    try directLockedCapturePermission()
    guard window.pid > 0, window.id != kCGNullWindowID,
          maxScale.isFinite, maxScale > 0 else {
        throw ToolError("The selected window or screenshot scale is invalid.")
    }
    guard let screenshot = try await withDeadline(4, { @MainActor in
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        let metadata = directLockedWindowMetadata()
        guard let target = content.windows.first(where: {
            $0.windowID == window.id && $0.owningApplication?.processID == window.pid
        }), let current = directLockedWindow(target, pid: window.pid, metadata: metadata) else {
            throw ToolError("The selected app window is no longer available. Get fresh app state before continuing.")
        }

        let filter = SCContentFilter(desktopIndependentWindow: target)
        let scale = captureScale(for: current.frame.size, maxScale: maxScale)
        guard scale.isFinite, scale > 0 else {
            throw ToolError("The selected window has invalid screenshot dimensions.")
        }
        let configuration = SCStreamConfiguration()
        configuration.width = max(1, Int((current.frame.width * scale).rounded()))
        configuration.height = max(1, Int((current.frame.height * scale).rounded()))
        configuration.showsCursor = false
        configuration.captureResolution = .best
        configuration.scalesToFit = true
        configuration.ignoreShadowsSingleWindow = true
        configuration.ignoreGlobalClipSingleWindow = true
        // No letterboxing: the returned image covers precisely the window
        // frame, with only the unavoidable subpixel rounding of output size.
        configuration.preservesAspectRatio = false
        if #available(macOS 14.2, *) { configuration.includeChildWindows = false }

        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        try Task.checkCancellation()
        guard image.width == configuration.width, image.height == configuration.height else {
            throw ToolError("The window screenshot dimensions changed unexpectedly. Get fresh app state before continuing.")
        }

        // A moved/resized/closed window must not leave clickable coordinates
        // mapped to a stale frame. This stays inside the same overall deadline.
        let updated = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
        let updatedMetadata = directLockedWindowMetadata()
        guard let targetAfter = updated.windows.first(where: {
            $0.windowID == window.id && $0.owningApplication?.processID == window.pid
        }), let after = directLockedWindow(targetAfter, pid: window.pid, metadata: updatedMetadata),
              after.frame == current.frame else {
            throw ToolError("The selected app window changed during capture. Get fresh app state before continuing.")
        }

        let format = ProcessInfo.processInfo.environment["SKFIY_SCREENSHOT_FORMAT"]?.lowercased() == "png" ? "png" : "jpeg"
        return Screenshot(
            geometry: CaptureGeometry(rect: current.frame, pixelWidth: image.width, pixelHeight: image.height),
            data: try encode(image, format: format),
            mimeType: format == "png" ? "image/png" : "image/jpeg"
        )
    }) else {
        throw ToolError("No screenshot: independent window capture did not answer within 4 s.")
    }
    try Task.checkCancellation()
    return screenshot
}

private func directLockedCapturePermission() throws {
    guard CGPreflightScreenCaptureAccess() else {
        throw ToolError("Screen Recording permission is not granted. Run `skfiy doctor`, then restart the host app (e.g. your terminal).")
    }
}

/// On-screen-only CG queries exclude the app under the lock screen. Use all
/// windows for optional alpha/ownership cross-checks, while SCK remains the
/// source of window eligibility and the mandatory owner PID check.
private func directLockedWindowMetadata() -> [CGWindowID: [String: Any]] {
    let entries = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    var result: [CGWindowID: [String: Any]] = [:]
    for entry in entries {
        if let id = entry[kCGWindowNumber as String] as? UInt32 { result[id] = entry }
    }
    return result
}

private func directLockedWindow(_ window: SCWindow, pid: pid_t, metadata: [CGWindowID: [String: Any]]) -> DirectLockedWindow? {
    let frame = window.frame
    guard window.windowID != kCGNullWindowID,
          window.owningApplication?.processID == pid,
          window.windowLayer == 0,
          !frame.isNull, !frame.isInfinite,
          frame.minX.isFinite, frame.minY.isFinite,
          frame.width.isFinite, frame.height.isFinite,
          frame.width >= 2, frame.height >= 2 else { return nil }
    // AppKit creates hidden input-method/helper windows which SCK lists too.
    // Under the lock screen the app's displayed windows retain this bit in
    // the all-windows CG query even though on-screen-only queries omit them.
    guard let details = metadata[window.windowID], details[kCGWindowIsOnscreen as String] as? Bool == true else { return nil }
    do {
        if let owner = details[kCGWindowOwnerPID as String] as? Int, owner != Int(pid) { return nil }
        if let layer = details[kCGWindowLayer as String] as? Int, layer != 0 { return nil }
        if let alpha = details[kCGWindowAlpha as String] as? Double, !alpha.isFinite || alpha <= 0 { return nil }
    }
    return DirectLockedWindow(id: window.windowID, pid: pid, title: window.title ?? "", frame: frame)
}
