import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// Maps between screenshot pixels and global screen points (top-left origin,
/// the space shared by AX frames and CGEvent locations).
public struct CaptureGeometry: Equatable, Sendable {
    public var rect: CGRect
    public var pixelWidth: Int
    public var pixelHeight: Int

    public init(rect: CGRect, pixelWidth: Int, pixelHeight: Int) {
        self.rect = rect
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
    }

    /// Screenshot pixels per screen point.
    public var scale: Double {
        rect.width > 0 ? Double(pixelWidth) / rect.width : 1
    }

    public func containsPixel(x: Double, y: Double) -> Bool {
        x >= 0 && y >= 0 && x <= Double(pixelWidth) && y <= Double(pixelHeight)
    }

    public func toScreen(x: Double, y: Double) -> CGPoint {
        CGPoint(x: rect.minX + x / scale, y: rect.minY + y / scale)
    }

    public func toPixels(_ point: CGPoint) -> CGPoint {
        CGPoint(x: (point.x - rect.minX) * scale, y: (point.y - rect.minY) * scale)
    }
}

/// Downscale factor that keeps a point-resolution capture inside the model's
/// image limits, so the model never sees a server-side-resized image whose
/// coordinates would no longer match ours. Never upscales.
/// Pixels per point for a capture of `size` points: at most `maxScale` (1 for
/// regular screenshots, the display's backing scale for zooms), within the
/// size limits the model handles well.
public func captureScale(for size: CGSize, maxLongEdge: Double = 1_568, maxPixels: Double = 1_150_000, maxScale: Double = 1) -> Double {
    let width = max(Double(size.width), 1)
    let height = max(Double(size.height), 1)
    return min(maxScale, maxLongEdge / max(width, height), (maxPixels / (width * height)).squareRoot())
}

struct Screenshot {
    let geometry: CaptureGeometry
    let data: Data
    let mimeType: String
}

/// Out-of-process AppKit panels (open/save dialogs of sandboxed apps) render in
/// these services, not in the app itself.
private let panelServiceBundleIDs: Set<String> = [
    "com.apple.appkit.xpc.openAndSavePanelService",
    "com.apple.quicklook.QuickLookUIService"
]

/// The screen region to show for an app: its focused window plus any of its
/// pop-up windows (menus, popovers, completion lists), clipped to one display.
func appRegion(pid: pid_t, focusedWindow: CGRect?) -> CGRect? {
    let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]]) ?? []
    var mainWindows: [CGRect] = []
    var popups: [CGRect] = []
    for window in windows {
        guard (window[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == pid,
              let boundsDictionary = window[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: boundsDictionary),
              bounds.width >= 2, bounds.height >= 2,
              ((window[kCGWindowAlpha as String] as? Double) ?? 1) > 0 else {
            continue
        }
        let layer = (window[kCGWindowLayer as String] as? Int) ?? 0
        if layer == 0 {
            mainWindows.append(bounds)
        } else if layer != Int(CGWindowLevelForKey(.mainMenuWindow)),
                  layer != Int(CGWindowLevelForKey(.statusWindow)) {
            popups.append(bounds)
        }
    }

    guard var region = focusedWindow ?? mainWindows.max(by: { $0.width * $0.height < $1.width * $1.height }) else {
        return nil
    }
    let display = displayBounds(containing: CGPoint(x: region.midX, y: region.midY))
    for popup in popups where popup.width * popup.height < display.width * display.height * 0.6 {
        if popup.intersects(display) {
            region = region.union(popup)
        }
    }
    let clipped = region.intersection(display)
    return clipped.isNull || clipped.width < 2 || clipped.height < 2 ? nil : clipped.integral
}

func displayBounds(containing point: CGPoint) -> CGRect {
    CGDisplayBounds(displayID(containing: point))
}

func displayID(containing point: CGPoint) -> CGDirectDisplayID {
    var count: UInt32 = 0
    var display: CGDirectDisplayID = 0
    if CGGetDisplaysWithPoint(point, 1, &display, &count) == .success, count > 0 {
        return display
    }
    return CGMainDisplayID()
}

/// Captures `rect` showing only `pid`'s windows (and the AppKit panel
/// services), so other apps overlapping it do not leak into the frame.
@MainActor
func captureApp(pid: pid_t, rect: CGRect, maxScale: Double = 1) async throws -> Screenshot {
    guard CGPreflightScreenCaptureAccess() else {
        throw ToolError("Screen Recording permission is not granted. Run `skfiy doctor`, then restart the host app (e.g. your terminal).")
    }
    if let reason = screenUnavailableReason() {
        throw ToolError("No screenshot: \(reason). The accessibility tree still works.")
    }
    let center = CGPoint(x: rect.midX, y: rect.midY)
    let displayID = displayID(containing: center)
    let bounds = CGDisplayBounds(displayID)
    let region = rect.intersection(bounds)
    guard !region.isNull, region.width >= 1, region.height >= 1 else {
        throw ToolError("The app's window is off screen.")
    }

    // ScreenCaptureKit reports odd errors ("the user declined", "failed to
    // start stream") for an app with nothing on screen; say what it is instead.
    let onScreen = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    var visible = false
    var panelServices: Set<pid_t> = []
    for window in onScreen {
        guard let owner = (window[kCGWindowOwnerPID as String] as? Int).map(pid_t.init),
              let dictionary = window[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: dictionary),
              frame.width >= 2, frame.height >= 2, frame.intersects(region) else { continue }
        if owner == pid {
            visible = true
        } else if panelServiceBundleIDs.contains(NSRunningApplication(processIdentifier: owner)?.bundleIdentifier ?? "") {
            panelServices.insert(owner)
        }
    }
    guard visible else {
        throw ToolError("No screenshot: none of the app's windows is on screen here (it may be on another desktop, in full screen, or minimized). The accessibility tree still works.")
    }
    if CaptureStall.active {
        return try await captureInHelper(pid: pid, rect: rect, maxScale: maxScale)
    }
    let content: SCShareableContent
    do {
        content = try await ShareableContentCache.shared.content(containing: pid, alsoShowing: panelServices)
    } catch is CaptureStall {
        guard CaptureStall.active else {
            throw ToolError("No screenshot: screen capture did not answer within 5 s. The accessibility tree still works.")
        }
        return try await captureInHelper(pid: pid, rect: rect, maxScale: maxScale)
    }
    guard let display = content.displays.first(where: { $0.displayID == displayID })
            ?? content.displays.first(where: { CGDisplayBounds($0.displayID).contains(center) }) else {
        await ShareableContentCache.shared.invalidate()
        throw ToolError("No display is available to capture.")
    }
    let applications = content.applications.filter {
        $0.processID == pid || panelServiceBundleIDs.contains($0.bundleIdentifier)
    }
    let filter = SCContentFilter(display: display, including: applications, exceptingWindows: [])
    let scale = captureScale(for: region.size, maxScale: maxScale)
    let configuration = SCStreamConfiguration()
    configuration.sourceRect = region.offsetBy(dx: -bounds.minX, dy: -bounds.minY)
    configuration.width = max(1, Int((region.width * scale).rounded()))
    configuration.height = max(1, Int((region.height * scale).rounded()))
    configuration.showsCursor = false
    configuration.ignoreShadowsDisplay = true

    var captured: CGImage?
    for attempt in 1...2 {
        do {
            // ScreenCaptureKit can stay silent (another process of the same binary
            // holding it, a stuck capture service); never let that hang a tool.
            guard let image = try await withDeadline(3, {
                try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            }) else {
                if let reason = screenUnavailableReason() {
                    throw ToolError("No screenshot: \(reason). The accessibility tree still works.")
                }
                CaptureStall.set()
                guard CaptureStall.active else {
                    throw ToolError("No screenshot: screen capture did not answer within 3 s. The accessibility tree still works.")
                }
                return try await captureInHelper(pid: pid, rect: rect, maxScale: maxScale)
            }
            captured = image
            break
        } catch let error as ToolError {
            throw error
        } catch {
            await ShareableContentCache.shared.invalidate()
            guard attempt < 2 else {
                throw ToolError("Screenshot failed: \(screenUnavailableReason() ?? error.localizedDescription). The accessibility tree still works.")
            }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
    }
    guard let image = captured else { throw ToolError("Screenshot failed.") }
    let format = ProcessInfo.processInfo.environment["SKFIY_SCREENSHOT_FORMAT"]?.lowercased() == "png" ? "png" : "jpeg"
    let data = try encode(image, format: format)
    return Screenshot(
        geometry: CaptureGeometry(rect: region, pixelWidth: image.width, pixelHeight: image.height),
        data: data,
        mimeType: format == "png" ? "image/png" : "image/jpeg"
    )
}

/// Screen capture can stop answering inside one process for good, while a
/// fresh process captures fine. After the first stall, screenshots are taken
/// by a short-lived helper process (`skfiy capture-window`) instead.
struct CaptureStall: Error {
    /// SKFIY_SIMULATE_CAPTURE_STALL=1 starts out stalled, for tests.
    @MainActor private static var stalled = ProcessInfo.processInfo.environment["SKFIY_SIMULATE_CAPTURE_STALL"] == "1"
    /// This process is a helper itself; it never hands off to another one.
    @MainActor static var isHelper = false

    @MainActor static var active: Bool { stalled && !isHelper }

    @MainActor static func set() {
        stalled = true
    }
}

@MainActor
private func captureInHelper(pid: pid_t, rect: CGRect, maxScale: Double) async throws -> Screenshot {
    let failed = ToolError("No screenshot: screen capture stopped answering. The accessibility tree still works.")
    guard let executable = Bundle.main.executableURL else { throw failed }
    let output = FileManager.default.temporaryDirectory.appendingPathComponent("skfiy-capture-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: output) }
    let process = Process()
    process.executableURL = executable
    process.arguments = ["capture-window", "\(pid)", "\(rect.minX)", "\(rect.minY)", "\(rect.width)", "\(rect.height)", "\(maxScale)", output.path]
    // A link of its own: screen capture serves one process per executable path.
    var environment = ProcessInfo.processInfo.environment
    environment[Instance.variable] = nil
    environment["SKFIY_SIMULATE_CAPTURE_STALL"] = nil
    process.environment = environment
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        let once = Once()
        process.terminationHandler = { _ in
            if once.claim() { continuation.resume() }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 6) {
            if once.claim() {
                process.terminate()
                continuation.resume(throwing: failed)
            }
        }
        do {
            try process.run()
        } catch {
            if once.claim() { continuation.resume(throwing: failed) }
        }
    }
    let answer = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    let fields = answer.split(separator: " ").map(String.init)
    guard process.terminationStatus == 0, fields.count == 8, fields[0] == "ok",
          let x = Double(fields[1]), let y = Double(fields[2]), let width = Double(fields[3]), let height = Double(fields[4]),
          let pixelWidth = Int(fields[5]), let pixelHeight = Int(fields[6]),
          let data = try? Data(contentsOf: output) else {
        throw answer.hasPrefix("error ") ? ToolError(String(answer.dropFirst(6))) : failed
    }
    return Screenshot(
        geometry: CaptureGeometry(rect: CGRect(x: x, y: y, width: width, height: height), pixelWidth: pixelWidth, pixelHeight: pixelHeight),
        data: data,
        mimeType: fields[7]
    )
}

/// `skfiy capture-window pid x y width height max-scale output-path`: one
/// screenshot, taken in a process of its own for an MCP server whose screen
/// capture stalled. Returns the line to print and whether it worked.
@MainActor
public func captureWindowCommand(_ arguments: [String]) async -> (output: String, ok: Bool) {
    guard arguments.count == 7, let pid = pid_t(arguments[0]),
          let x = Double(arguments[1]), let y = Double(arguments[2]),
          let width = Double(arguments[3]), let height = Double(arguments[4]),
          let maxScale = Double(arguments[5]) else {
        return ("error usage: skfiy capture-window pid x y width height max-scale output-path", false)
    }
    CaptureStall.isHelper = true
    do {
        let shot = try await captureApp(pid: pid, rect: CGRect(x: x, y: y, width: width, height: height), maxScale: maxScale)
        try shot.data.write(to: URL(fileURLWithPath: arguments[6]))
        let rect = shot.geometry.rect
        return ("ok \(rect.minX) \(rect.minY) \(rect.width) \(rect.height) \(shot.geometry.pixelWidth) \(shot.geometry.pixelHeight) \(shot.mimeType)", true)
    } catch let error as ToolError {
        return ("error " + error.description, false)
    } catch {
        return ("error \(error.localizedDescription)", false)
    }
}

func encode(_ image: CGImage, format: String) throws -> Data {
    let data = NSMutableData()
    let type = (format == "png" ? UTType.png : UTType.jpeg).identifier as CFString
    guard let destination = CGImageDestinationCreateWithData(data, type, 1, nil) else {
        throw ToolError("Could not encode the screenshot.")
    }
    let options = [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary
    CGImageDestinationAddImage(destination, image, format == "png" ? nil : options)
    guard CGImageDestinationFinalize(destination) else {
        throw ToolError("Could not encode the screenshot.")
    }
    return data as Data
}

/// Waits for `operation` at most `seconds`, then returns nil. The operation
/// keeps running (ScreenCaptureKit calls cannot be cancelled), so this does
/// not use a task group, which would wait for it.
func withDeadline<T>(_ seconds: Double, _ operation: @escaping () async throws -> T) async throws -> T? {
    let once = Once()
    return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T?, Error>) in
        Task {
            do {
                let value = try await operation()
                if once.claim() { continuation.resume(returning: value) }
            } catch {
                if once.claim() { continuation.resume(throwing: error) }
            }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + seconds) {
            if once.claim() { continuation.resume(returning: nil) }
        }
    }
}

/// A flag that can be claimed once, from any thread.
final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false

    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}

/// The list of capturable apps and displays. A screenshot needs only the app
/// and display objects from it, which stay valid while the app runs, so it is
/// fetched again only when an app is missing or a capture failed: the capture
/// service turns listings down ("the user declined") for a while after busy
/// use, and then the last listing still serves the apps it has.
actor ShareableContentCache {
    static let shared = ShareableContentCache()
    private var cached: SCShareableContent?
    private var stale = false

    func content(containing pid: pid_t, alsoShowing others: Set<pid_t> = []) async throws -> SCShareableContent {
        let has = { (content: SCShareableContent, pid: pid_t) in content.applications.contains { $0.processID == pid } }
        if let cached, !stale, has(cached, pid), others.allSatisfy({ has(cached, $0) }) {
            return cached
        }
        var failure = "it did not answer within 5 s"
        for attempt in 1...3 {
            do {
                if let listed = try await withDeadline(5, {
                    try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
                }) {
                    cached = listed
                    stale = false
                    return listed
                }
                if screenUnavailableReason() == nil {
                    await CaptureStall.set()
                    throw CaptureStall()
                }
                break
            } catch {
                failure = error.localizedDescription
                if attempt < 3 { try? await Task.sleep(nanoseconds: 1_000_000_000) }
            }
        }
        if let cached, has(cached, pid) {
            return cached
        }
        throw ToolError("Screen capture is unavailable right now (\(failure)). The accessibility tree still works; try a screenshot again in a minute.")
    }

    func invalidate() {
        stale = true
    }
}
