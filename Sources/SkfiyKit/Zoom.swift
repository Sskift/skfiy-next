import CoreGraphics
import Foundation

/// How a zoomed image relates to the screenshot it was cut from: a region
/// of that screenshot (in its pixels) shown at `zoomWidth` × `zoomHeight`.
/// Points in the zoom map back to screenshot pixels, and from there through
/// the screenshot's own geometry to the screen.
struct ZoomMapping: Equatable, Sendable {
    let id: String
    /// The zoomed part, in pixels of the screenshot it came from.
    let region: CGRect
    let zoomWidth: Int
    let zoomHeight: Int
    /// The screenshot it refers to: its geometry and when it was taken.
    let screenshot: CaptureGeometry
    let screenshotTaken: Date

    var factorX: Double { Double(zoomWidth) / Double(region.width) }
    var factorY: Double { Double(zoomHeight) / Double(region.height) }

    func toScreenshot(_ point: CGPoint) -> CGPoint {
        CGPoint(x: region.minX + point.x / factorX, y: region.minY + point.y / factorY)
    }

    func toZoom(_ point: CGPoint) -> CGPoint {
        CGPoint(x: (point.x - region.minX) * factorX, y: (point.y - region.minY) * factorY)
    }

    func toScreen(_ point: CGPoint) -> CGPoint {
        let pixel = toScreenshot(point)
        return screenshot.toScreen(x: pixel.x, y: pixel.y)
    }

    func containsZoomPixel(x: Double, y: Double) -> Bool {
        x.isFinite && y.isFinite && x >= 0 && y >= 0 && x <= Double(zoomWidth) && y <= Double(zoomHeight)
    }

    /// For the model: how to turn a point it reads off the zoom into x/y.
    var formula: String {
        let fx = formatNumber((factorX * 1000).rounded() / 1000)
        let fy = formatNumber((factorY * 1000).rounded() / 1000)
        return "screenshot x = \(formatNumber(region.minX)) + zoom_x / \(fx), y = \(formatNumber(region.minY)) + zoom_y / \(fy)"
    }

    /// Zoom pixels per screenshot pixel: the requested factor, within the
    /// model's image limits (it must never resize the image itself, or the
    /// mapping would be off).
    static func factor(requested: Double?, native: Double, region: CGSize,
                       maxLongEdge: Double = 1_568, maxPixels: Double = 1_150_000) -> Double {
        let wanted = max(1, min(requested ?? native, 8))
        let limit = min(maxLongEdge / max(region.width, region.height),
                        (maxPixels / max(region.width * region.height, 1)).squareRoot())
        return max(min(wanted, limit), min(1, limit))
    }
}

/// Validates and parses x/y/width/height in pixels of a screenshot.
func zoomRegion(_ args: Arguments, geometry: CaptureGeometry) throws -> CGRect {
    guard let x = try args.double("x"), let y = try args.double("y"),
          let width = try args.double("width"), let height = try args.double("height"),
          [x, y, width, height].allSatisfy(\.isFinite) else {
        throw ToolError("Pass x, y, width and height: a region in pixels of the latest screenshot.")
    }
    guard width >= 4, height >= 4, x >= 0, y >= 0,
          x + width <= Double(geometry.pixelWidth) + 0.5, y + height <= Double(geometry.pixelHeight) + 0.5 else {
        throw ToolError("The region must be at least 4×4 px and inside the latest \(geometry.pixelWidth)×\(geometry.pixelHeight) screenshot.")
    }
    return CGRect(x: x, y: y, width: min(width, Double(geometry.pixelWidth) - x), height: min(height, Double(geometry.pixelHeight) - y))
}

/// The zoom image: `region` (screenshot pixels) cut from a capture of the
/// same frame at higher resolution, then sized to the zoom factor. The cut
/// follows whole capture pixels, so the region actually shown (returned) can
/// differ from the requested one by a fraction of a pixel; the mapping uses it.
func cutZoom(from capture: CGImage, captureGeometry: CaptureGeometry, screenshot: CaptureGeometry, region: CGRect,
             factor: Double) -> (image: CGImage, crop: CGImage, shown: CGRect)? {
    // Screenshot pixels → screen points → capture pixels (the frames are equal).
    let a = captureGeometry.toPixels(screenshot.toScreen(x: region.minX, y: region.minY))
    let b = captureGeometry.toPixels(screenshot.toScreen(x: region.maxX, y: region.maxY))
    let cropRect = CGRect(x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y)
        .integral.intersection(CGRect(x: 0, y: 0, width: capture.width, height: capture.height))
    guard !cropRect.isNull, cropRect.width >= 1, cropRect.height >= 1, let crop = capture.cropping(to: cropRect) else { return nil }
    let shownTopLeft = screenshot.toPixels(captureGeometry.toScreen(x: cropRect.minX, y: cropRect.minY))
    let shownBottomRight = screenshot.toPixels(captureGeometry.toScreen(x: cropRect.maxX, y: cropRect.maxY))
    let shown = CGRect(x: shownTopLeft.x, y: shownTopLeft.y,
                       width: shownBottomRight.x - shownTopLeft.x, height: shownBottomRight.y - shownTopLeft.y)
    let width = max(1, Int((shown.width * factor).rounded()))
    let height = max(1, Int((shown.height * factor).rounded()))
    guard let image = resized(crop, width: width, height: height) else { return nil }
    return (image, crop, shown)
}
