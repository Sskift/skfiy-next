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
public func captureScale(for size: CGSize, maxLongEdge: Double = 1_568, maxPixels: Double = 1_150_000) -> Double {
    let width = max(Double(size.width), 1)
    let height = max(Double(size.height), 1)
    return min(1, maxLongEdge / max(width, height), (maxPixels / (width * height)).squareRoot())
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
    var count: UInt32 = 0
    var display: CGDirectDisplayID = 0
    if CGGetDisplaysWithPoint(point, 1, &display, &count) == .success, count > 0 {
        return CGDisplayBounds(display)
    }
    return CGDisplayBounds(CGMainDisplayID())
}

/// Captures `rect` showing only `pid`'s windows (and the AppKit panel
/// services), so other apps overlapping it do not leak into the frame.
@MainActor
func captureApp(pid: pid_t, rect: CGRect) async throws -> Screenshot {
    guard CGPreflightScreenCaptureAccess() else {
        throw ToolError("Screen Recording permission is not granted. Run `skfiy doctor`, then restart the host app (e.g. your terminal).")
    }
    let content: SCShareableContent
    do {
        guard let listed = try await withDeadline(5, {
            try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        }) else {
            throw ToolError("No screenshot: screen capture did not answer within 5 s. The accessibility tree still works.")
        }
        content = listed
    } catch let error as ToolError {
        throw error
    } catch {
        throw ToolError("Screen capture is unavailable: \(error.localizedDescription)")
    }
    let center = CGPoint(x: rect.midX, y: rect.midY)
    guard let display = content.displays.first(where: { CGDisplayBounds($0.displayID).contains(center) })
            ?? content.displays.first else {
        throw ToolError("No display is available to capture.")
    }
    let bounds = CGDisplayBounds(display.displayID)
    let region = rect.intersection(bounds)
    guard !region.isNull, region.width >= 1, region.height >= 1 else {
        throw ToolError("The app's window is off screen.")
    }

    let applications = content.applications.filter {
        $0.processID == pid || panelServiceBundleIDs.contains($0.bundleIdentifier)
    }
    let filter = SCContentFilter(display: display, including: applications, exceptingWindows: [])
    let scale = captureScale(for: region.size)
    let configuration = SCStreamConfiguration()
    configuration.sourceRect = region.offsetBy(dx: -bounds.minX, dy: -bounds.minY)
    configuration.width = max(1, Int((region.width * scale).rounded()))
    configuration.height = max(1, Int((region.height * scale).rounded()))
    configuration.showsCursor = false
    configuration.ignoreShadowsDisplay = true

    let image: CGImage
    do {
        // ScreenCaptureKit can stay silent (another process of the same binary
        // holding it, a stuck capture service); never let that hang a tool.
        guard let captured = try await withDeadline(5, {
            try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        }) else {
            throw ToolError("No screenshot: screen capture did not answer within 5 s. The accessibility tree still works.")
        }
        image = captured
    } catch let error as ToolError {
        throw error
    } catch {
        throw ToolError("Screenshot failed: \(error.localizedDescription)")
    }
    let format = ProcessInfo.processInfo.environment["SKFIY_SCREENSHOT_FORMAT"]?.lowercased() == "png" ? "png" : "jpeg"
    let data = try encode(image, format: format)
    return Screenshot(
        geometry: CaptureGeometry(rect: region, pixelWidth: image.width, pixelHeight: image.height),
        data: data,
        mimeType: format == "png" ? "image/png" : "image/jpeg"
    )
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
