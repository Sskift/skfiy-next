import AppKit
import CoreGraphics
import Foundation
import IOKit.pwr_mgt
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

/// Captures exactly the selected window, encoded for the model.
@MainActor
func captureDirectLockedWindow(_ window: DirectLockedWindow, maxScale: Double = 1) async throws -> Screenshot {
    let (image, geometry) = try await captureDirectLockedImage(window, maxScale: maxScale)
    return try encodeScreenshot(image, geometry: geometry)
}

func encodeScreenshot(_ image: CGImage, geometry: CaptureGeometry) throws -> Screenshot {
    let format = ProcessInfo.processInfo.environment["SKFIY_SCREENSHOT_FORMAT"]?.lowercased() == "png" ? "png" : "jpeg"
    return Screenshot(geometry: geometry, data: try encode(image, format: format), mimeType: format == "png" ? "image/png" : "image/jpeg")
}

/// A display in global screen points with a top-left origin (the space of
/// window frames and events): displays left of or above the main one have
/// negative coordinates.
struct DisplayInfo: Equatable {
    let frame: CGRect
    let scale: Double
}

/// The connected displays, converted from AppKit's bottom-left coordinates.
func displayInfos() -> [DisplayInfo] {
    let top = NSScreen.screens.first?.frame.maxY ?? 0
    return NSScreen.screens.map { screen in
        let frame = screen.frame
        return DisplayInfo(frame: CGRect(x: frame.minX, y: top - frame.maxY, width: frame.width, height: frame.height),
                           scale: Double(screen.backingScaleFactor))
    }
}

/// The display a window is on: the one holding its center, else the one it
/// overlaps most, else the nearest (a window dragged off every display).
func display(for rect: CGRect, among displays: [DisplayInfo]) -> DisplayInfo? {
    let center = CGPoint(x: rect.midX, y: rect.midY)
    if let holding = displays.first(where: { $0.frame.contains(center) }) { return holding }
    let overlap = { (display: DisplayInfo) -> CGFloat in
        let shared = display.frame.intersection(rect)
        return shared.isNull ? 0 : shared.width * shared.height
    }
    if let most = displays.max(by: { overlap($0) < overlap($1) }), overlap(most) > 0 { return most }
    let distance = { (display: DisplayInfo) -> CGFloat in
        let dx = max(display.frame.minX - center.x, 0, center.x - display.frame.maxX)
        let dy = max(display.frame.minY - center.y, 0, center.y - display.frame.maxY)
        return dx * dx + dy * dy
    }
    return displays.min(by: { distance($0) < distance($1) })
}

/// The display's pixels per point where `rect` is (2 on Retina, 1 on most
/// external displays), so captures use each display's own detail.
func backingScale(for rect: CGRect, displays: [DisplayInfo] = displayInfos()) -> Double {
    display(for: rect, among: displays)?.scale ?? displays.map(\.scale).max() ?? 2
}

/// `image` resized to exactly width × height pixels.
func resized(_ image: CGImage, width: Int, height: Int) -> CGImage? {
    if image.width == width && image.height == height { return image }
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return context.makeImage()
}

/// Captures exactly the selected window, without switching desktops,
/// unlocking the session, or falling back to a display capture. Fresh SCK
/// objects and matching ownership are required for each screenshot.
@MainActor
func captureDirectLockedImage(_ window: DirectLockedWindow, maxScale: Double = 1) async throws -> (CGImage, CaptureGeometry) {
    try Task.checkCancellation()
    try directLockedCapturePermission()
    try await DisplayWake.require(for: window.frame)
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

        return (image, CaptureGeometry(rect: current.frame, pixelWidth: image.width, pixelHeight: image.height))
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


/// Window capture needs the display on: with it asleep, as it soon is on a
/// locked Mac, ScreenCaptureKit fails with an internal error. While macOS is
/// locked in direct mode, the display is woken to the lock screen (which
/// shows nothing of the user's) and kept on until two minutes after the last
/// capture; SKFIY_LOCKED_WAKE_DISPLAY=0 turns that off. Unlocked, a display
/// that is asleep is left asleep: the user may have turned it off.
@MainActor
enum DisplayWake {
    static var enabled: Bool { ProcessInfo.processInfo.environment["SKFIY_LOCKED_WAKE_DISPLAY"] != "0" }
    private static var keepOn: IOPMAssertionID = 0
    private static var release: Task<Void, Never>?
    /// When skfiy last woke a display, for the capability report.
    private(set) static var lastWoken: Date?

    static func asleep(_ frame: CGRect) -> Bool {
        CGDisplayIsAsleep(displayID(containing: CGPoint(x: frame.midX, y: frame.midY))) != 0
    }

    static var anyAsleep: Bool {
        var count: UInt32 = 0
        var displays = [CGDirectDisplayID](repeating: 0, count: 16)
        guard CGGetOnlineDisplayList(16, &displays, &count) == .success, count > 0 else { return false }
        return displays.prefix(Int(count)).contains { CGDisplayIsAsleep($0) != 0 }
    }

    /// Throws, saying why, when the display showing `frame` is asleep and
    /// cannot be woken here; wakes it when it can.
    static func require(for frame: CGRect) async throws {
        let lockedDirect = DirectLockedUse.enabled && DirectLockedUse.lockState == .locked
        if lockedDirect { hold() }
        guard asleep(frame) else { return }
        guard lockedDirect else {
            throw ToolError("No screenshot: the display is asleep (off). Window capture needs it on; skfiy wakes it only while macOS is locked in direct mode.")
        }
        guard enabled else {
            throw ToolError("No screenshot: the display is asleep (off), and SKFIY_LOCKED_WAKE_DISPLAY=0 keeps skfiy from waking it. Window capture needs the display on.")
        }
        var activity: IOPMAssertionID = 0
        IOPMAssertionDeclareUserActivity("skfiy direct locked use: window capture" as CFString, kIOPMUserActiveLocal, &activity)
        lastWoken = Date()
        for _ in 0..<40 where asleep(frame) {
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        guard !asleep(frame) else {
            throw ToolError("No screenshot: the display is asleep (off) and did not wake within 4 s. Window capture needs it on.")
        }
        // The window server needs a moment to draw again after waking.
        try await Task.sleep(nanoseconds: 400_000_000)
    }

    /// Keeps the display from going to sleep until two minutes after the
    /// last capture, so a task does not lose it halfway.
    private static func hold() {
        guard enabled else { return }
        if keepOn == 0 {
            IOPMAssertionCreateWithName(kIOPMAssertPreventUserIdleDisplaySleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn),
                                        "skfiy direct locked use" as CFString, &keepOn)
        }
        release?.cancel()
        release = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 120_000_000_000)
            guard !Task.isCancelled else { return }
            if keepOn != 0 { IOPMAssertionRelease(keepOn) }
            keepOn = 0
        }
    }
}
