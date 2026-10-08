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
    static func factor(requested: Double?, native: Double, region: CGSize) -> Double {
        let wanted = max(1, min(requested ?? native, 8))
        let limit = min(ModelImage.longEdge / max(region.width, region.height),
                        (ModelImage.pixels / max(region.width * region.height, 1)).squareRoot())
        return max(min(wanted, limit), min(1, limit))
    }
}

extension ZoomMapping {
    /// Zoom pixels per screenshot pixel for a zoom request: its scale (1-8),
    /// else the display's full detail; within the model's image limits.
    static func factor(_ args: Arguments, native: Double, region: CGRect) throws -> Double {
        let requested = try args.double("scale")
        if let requested, !requested.isFinite || requested < 1 || requested > 8 {
            throw ToolError("scale must be between 1 and 8 (zoom pixels per screenshot pixel).")
        }
        return factor(requested: requested, native: native, region: region.size)
    }

    /// What the result says first: the part of the screenshot shown, at what
    /// size and detail, and how its pixels map back. `subject` follows the
    /// id (" of window 12"); `lasting` ends the sentence on zoom_id.
    func lines(factor: Double, native: Double, subject: String = "", lasting: String) -> [String] {
        let detail = factor > native + 0.01 ? "upscaled beyond the display's \(formatNumber(native))× detail" : "\(formatNumber((factor / native * 100).rounded()))% of the display's detail"
        return [
            "Zoom \(id)\(subject): x=\(formatNumber(region.minX.rounded())) y=\(formatNumber(region.minY.rounded())) w=\(formatNumber(region.width.rounded())) h=\(formatNumber(region.height.rounded())) px of the latest screenshot, as \(zoomWidth)×\(zoomHeight) px (\(formatNumber((factor * 100).rounded() / 100))×; \(detail)).",
            "Coordinates: \(formula). Or pass zoom_id \"\(id)\" with x/y in this zoom's pixels to click, scroll or drag\(lasting)"
        ]
    }

    /// The text recognized in the zoom image, `showing` that part of the
    /// screen, at zoom x/y and screenshot x/y.
    func recognizedText(in image: CGImage, showing rect: CGRect) async throws -> [String] {
        // The zoom image itself: tiny glyphs read better enlarged.
        let recognized = TextRecognition.sorted(try await TextRecognition.recognize(image, showing: rect))
        var lines = [recognized.isEmpty ? "Text recognized in the zoom: none." : "Text recognized in the zoom (zoom x/y, then the same point in the screenshot):"]
        for text in recognized.prefix(100) {
            let pixel = screenshot.toPixels(CGPoint(x: text.frame.midX, y: text.frame.midY))
            let zoomed = toZoom(pixel)
            lines.append("  \(quote(text.text, limit: 100)) zoom x=\(Int(zoomed.x.rounded())) y=\(Int(zoomed.y.rounded())) → screenshot x=\(Int(pixel.x.rounded())) y=\(Int(pixel.y.rounded()))")
        }
        return lines
    }
}

/// The screen point of x/y read off the zoom named by zoom_id, or nil
/// without zoom_id. It must be `latest`, cut from the screenshot taken at
/// `taken` with `screenshot`; `notDone` ends the message when it is not.
func zoomPoint(_ args: Arguments, _ xKey: String, _ yKey: String, latest: ZoomMapping?, screenshot: CaptureGeometry?,
               taken: Date?, notDone: String) throws -> CGPoint? {
    guard let zoomID = args.string("zoom_id")?.trimmingCharacters(in: .whitespaces), !zoomID.isEmpty else { return nil }
    guard let mapping = latest, mapping.id == zoomID else {
        throw ToolError("zoom_id \(zoomID) is not the latest zoom of this app. Zoom again, or use x/y of the latest screenshot.")
    }
    guard mapping.screenshotTaken == taken, mapping.screenshot == screenshot else {
        throw ToolError("zoom_id \(zoomID) belongs to an older screenshot. Zoom again on the latest one; \(notDone).")
    }
    guard let x = try args.double(xKey), let y = try args.double(yKey), mapping.containsZoomPixel(x: x, y: y) else {
        throw ToolError("\(xKey)/\(yKey) must be inside zoom \(zoomID) (\(mapping.zoomWidth)×\(mapping.zoomHeight) px).")
    }
    return mapping.toScreen(CGPoint(x: x, y: y))
}

/// Validates and parses x/y/width/height in pixels of a screenshot.
func zoomRegion(_ args: Arguments, geometry: CaptureGeometry) throws -> CGRect {
    guard let x = try args.double("x"), let y = try args.double("y"),
          let width = try args.double("width"), let height = try args.double("height"),
          [x, y, width, height].allSatisfy(\.isFinite) else {
        throw ToolError("Pass x, y, width and height: a region in pixels of the latest screenshot.")
    }
    try checkRegion(x: x, y: y, width: width, height: height, in: geometry, slack: 0.5)
    return CGRect(x: x, y: y, width: min(width, Double(geometry.pixelWidth) - x), height: min(height, Double(geometry.pixelHeight) - y))
}

/// A region in pixels of a screenshot must be at least 4×4 and inside it;
/// `slack` lets it end a fraction of a pixel past the far edges.
func checkRegion(x: Double, y: Double, width: Double, height: Double, in geometry: CaptureGeometry, slack: Double = 0) throws {
    guard width >= 4, height >= 4, x >= 0, y >= 0,
          x + width <= Double(geometry.pixelWidth) + slack, y + height <= Double(geometry.pixelHeight) + slack else {
        throw ToolError("The region must be at least 4×4 px and inside the latest \(geometry.pixelWidth)×\(geometry.pixelHeight) screenshot.")
    }
}

/// The zoom image: `region` (screenshot pixels) cut from a capture of the
/// same frame at higher resolution, then sized to the zoom factor. The cut
/// follows whole capture pixels, so the region actually shown (returned) can
/// differ from the requested one by a fraction of a pixel; the mapping uses it.
func cutZoom(from capture: CGImage, captureGeometry: CaptureGeometry, screenshot: CaptureGeometry, region: CGRect,
             factor: Double) -> (image: CGImage, shown: CGRect)? {
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
    return (image, shown)
}
