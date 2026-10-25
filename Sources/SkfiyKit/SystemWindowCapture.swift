import AppKit
import CoreGraphics
import Foundation

/// A separate system capture process survives a stuck SCK connection. Capture
/// window IDs, never the desktop region (which could contain another app).
@MainActor
func captureSystemWindow(_ window: DirectLockedWindow, maxScale: Double = 1,
                         modelLimits: Bool = true, timeout: Double = 3) async throws -> (CGImage, CaptureGeometry) {
    guard !isScreenLocked(), CGPreflightScreenCaptureAccess(), windowOwner(window.id) == window.pid,
          let before = systemCaptureWindow(window.id), before.frame == window.frame else {
        throw ToolError("System window capture is unavailable or the target changed; get fresh app state.")
    }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("skfiy-shot-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let output = directory.appendingPathComponent("window.png")
    try await runCaptureProcess(output: output, window: window.id, timeout: timeout)
    try Task.checkCancellation()
    guard !isScreenLocked(), systemCaptureWindow(window.id) == before,
          let data = try? Data(contentsOf: output), let raw = TextRecognition.decode(data) else {
        throw ToolError("The window changed during system capture or returned no image; get fresh app state.")
    }
    let scale = modelLimits ? captureScale(for: window.frame.size, maxScale: maxScale) : maxScale
    let width = max(1, Int((window.frame.width * scale).rounded()))
    let height = max(1, Int((window.frame.height * scale).rounded()))
    // -o excludes shadows; the remaining image must have the window's aspect ratio.
    guard abs(Double(raw.width) / Double(raw.height) - window.frame.width / window.frame.height) < 0.02,
          let image = resized(raw, width: width, height: height) else {
        throw ToolError("System capture returned unexpected window dimensions; coordinates are unavailable.")
    }
    return (image, CaptureGeometry(rect: window.frame, pixelWidth: width, pixelHeight: height))
}

func systemCaptureWindow(_ id: CGWindowID) -> DirectLockedWindow? {
    let rows = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]] ?? []
    guard let row = rows.first, row[kCGWindowIsOnscreen as String] as? Bool == true,
          let owner = row[kCGWindowOwnerPID as String] as? Int,
          let bounds = row[kCGWindowBounds as String] as? NSDictionary,
          let rect = CGRect(dictionaryRepresentation: bounds), rect.width >= 2, rect.height >= 2 else { return nil }
    return DirectLockedWindow(id: id, pid: pid_t(owner), title: row[kCGWindowName as String] as? String ?? "", frame: rect)
}

@MainActor
private func runCaptureProcess(output: URL, window: CGWindowID, timeout: Double) async throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-o", "-l", String(window), "-t", "png", output.path]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    let start = ProcessInfo.processInfo.systemUptime
    while process.isRunning {
        if Task.isCancelled || ProcessInfo.processInfo.systemUptime - start > timeout {
            // Wait for termination before removing the output directory; a late
            // writer must not leave artifacts or keep the tool blocked.
            kill(process.processIdentifier, SIGKILL)
            while process.isRunning { await Input.pause(0.01) }
            throw ToolError("System window capture timed out or was cancelled. No stale screenshot was returned.")
        }
        await Input.pause(0.02)
    }
    guard process.terminationStatus == 0 else { throw ToolError("System window capture failed (\(process.terminationStatus)).") }
}

@MainActor
func captureSystemApp(pid: pid_t, rect: CGRect, maxScale: Double, windowIDs: Set<CGWindowID>? = nil, modelLimits: Bool = true) async throws -> Screenshot {
    let associated = Set(appWindows(AXUIElementCreateApplication(pid)).compactMap(windowID(of:)))
    let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let windows = rows.compactMap { row -> DirectLockedWindow? in
        guard let id = row[kCGWindowNumber as String] as? UInt32,
              let owner = row[kCGWindowOwnerPID as String] as? Int,
              owner == Int(pid) || associated.contains(id),
              windowIDs?.contains(id) ?? true,
              let window = systemCaptureWindow(id), window.frame.intersects(rect),
              (row[kCGWindowAlpha as String] as? Double ?? 1) > 0 else { return nil }
        return window
    }
    guard !windows.isEmpty, windows.count <= 16 else { throw ToolError("No bounded set of app windows is available for system capture.") }
    let scale = modelLimits ? captureScale(for: rect.size, maxScale: maxScale) : maxScale
    let width = max(1, Int((rect.width * scale).rounded()))
    let height = max(1, Int((rect.height * scale).rounded()))
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        throw ToolError("Could not allocate system screenshot.")
    }
    let started = ProcessInfo.processInfo.systemUptime
    for window in windows.reversed() {
        let remaining = 6 - (ProcessInfo.processInfo.systemUptime - started)
        guard remaining > 0 else { throw ToolError("System app capture exhausted its 6 s budget.") }
        let (image, _) = try await captureSystemWindow(window, maxScale: maxScale, modelLimits: modelLimits, timeout: min(3, remaining))
        let frame = window.frame
        context.draw(image, in: CGRect(x: (frame.minX - rect.minX) * CGFloat(width) / rect.width,
                                       y: (rect.maxY - frame.maxY) * CGFloat(height) / rect.height,
                                       width: frame.width * CGFloat(width) / rect.width,
                                       height: frame.height * CGFloat(height) / rect.height))
    }
    guard windows.allSatisfy({ systemCaptureWindow($0.id) == $0 }), let image = context.makeImage() else {
        throw ToolError("The app's windows changed during recovery; get fresh app state.")
    }
    return try encodeScreenshot(image, geometry: CaptureGeometry(rect: rect, pixelWidth: width, pixelHeight: height))
}

@MainActor
func captureSystemView(_ window: DirectLockedWindow, maxScale: Double, modelLimits: Bool, children: Bool) async throws -> (CGImage, CaptureGeometry) {
    guard children, let root = appWindows(AXUIElementCreateApplication(window.pid)).first(where: { windowID(of: $0) == window.id }) else {
        return try await captureSystemWindow(window, maxScale: maxScale, modelLimits: modelLimits)
    }
    let descendants = root.descendants(limit: 2000) { [kAXWindowRole, kAXSheetRole].contains($0.string(kAXRoleAttribute) ?? "") }
    let ids = Set(descendants.compactMap(windowID(of:))).union([window.id])
    guard ids.count > 1 else { return try await captureSystemWindow(window, maxScale: maxScale, modelLimits: modelLimits) }
    let shot = try await captureSystemApp(pid: window.pid, rect: window.frame, maxScale: maxScale, windowIDs: ids, modelLimits: modelLimits)
    guard let image = TextRecognition.decode(shot.data) else { throw ToolError("Could not decode the recovered window image.") }
    return (image, shot.geometry)
}
