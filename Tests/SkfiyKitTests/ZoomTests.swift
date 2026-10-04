import CoreGraphics
import Foundation
import Testing
@testable import SkfiyKit

struct ZoomTests {
    private let screenshot = CaptureGeometry(rect: CGRect(x: 100, y: 50, width: 700, height: 520), pixelWidth: 700, pixelHeight: 520)

    @Test(arguments: [1.0, 2.0, 3.0, 4.0, 2.5])
    func zoomPixelsMapBackAtEveryScale(factor: Double) {
        let region = CGRect(x: 40, y: 200, width: 120, height: 60)
        let mapping = ZoomMapping(id: "z1", region: region, zoomWidth: Int((120 * factor).rounded()), zoomHeight: Int((60 * factor).rounded()),
                                  screenshot: screenshot, screenshotTaken: Date())
        // The zoom's corners are the region's corners.
        #expect(mapping.toScreenshot(.zero) == CGPoint(x: 40, y: 200))
        let corner = mapping.toScreenshot(CGPoint(x: mapping.zoomWidth, y: mapping.zoomHeight))
        #expect(abs(corner.x - 160) < 1e-9 && abs(corner.y - 260) < 1e-9)
        // A target at screenshot (95.5, 231.25) is at the same screen point either way.
        let target = CGPoint(x: 95.5, y: 231.25)
        let zoomed = mapping.toZoom(target)
        let back = mapping.toScreenshot(zoomed)
        #expect(abs(back.x - target.x) < 1e-9 && abs(back.y - target.y) < 1e-9)
        #expect(mapping.toScreen(zoomed) == screenshot.toScreen(x: target.x, y: target.y))
        #expect(mapping.containsZoomPixel(x: zoomed.x, y: zoomed.y))
        #expect(!mapping.containsZoomPixel(x: -1, y: 0) && !mapping.containsZoomPixel(x: .nan, y: 0))
    }

    @Test func factorStaysWithinTheModelsImageLimits() {
        #expect(ZoomMapping.factor(requested: nil, native: 2, region: CGSize(width: 100, height: 50)) == 2)
        #expect(ZoomMapping.factor(requested: 4, native: 2, region: CGSize(width: 100, height: 50)) == 4)
        // 700 px wide at 4× would be 2800 px: capped at 1568 / 700.
        let capped = ZoomMapping.factor(requested: 4, native: 2, region: CGSize(width: 700, height: 100))
        #expect(abs(capped - 1568.0 / 700.0) < 1e-9)
        // Never below 1 unless even 1× is too big.
        #expect(ZoomMapping.factor(requested: 1, native: 2, region: CGSize(width: 2000, height: 100)) < 1)
        #expect(ZoomMapping.factor(requested: 0.2, native: 2, region: CGSize(width: 50, height: 50)) == 1)
    }

    @Test func formulaReadsLikeTheMapping() {
        let mapping = ZoomMapping(id: "z3", region: CGRect(x: 10, y: 20, width: 100, height: 50), zoomWidth: 300, zoomHeight: 150,
                                  screenshot: screenshot, screenshotTaken: Date())
        #expect(mapping.formula == "screenshot x = 10 + zoom_x / 3, y = 20 + zoom_y / 3")
    }

    @Test func cutCoversExactlyTheRegionItReports() throws {
        // A 2× capture of the same 700×520 pt frame, with a mark at screen point (300, 310).
        let capture = CaptureGeometry(rect: screenshot.rect, pixelWidth: 1400, pixelHeight: 1040)
        let context = try #require(CGContext(data: nil, width: 1400, height: 1040, bitsPerComponent: 8, bytesPerRow: 0,
                                             space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 1400, height: 1040))
        let mark = capture.toPixels(CGPoint(x: 300, y: 310))
        context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        context.fill(CGRect(x: mark.x - 2, y: 1040 - mark.y - 2, width: 4, height: 4))  // CG is bottom-up
        let image = try #require(context.makeImage())
        // A region with fractional edges.
        let region = CGRect(x: 150.3, y: 230.7, width: 100.2, height: 60.4)
        let cut = try #require(cutZoom(from: image, captureGeometry: capture, screenshot: screenshot, region: region, factor: 3))
        #expect(abs(cut.shown.minX - region.minX) <= 0.5 && abs(cut.shown.maxX - region.maxX) <= 0.5)
        #expect(cut.image.width == Int((cut.shown.width * 3).rounded()))
        let mapping = ZoomMapping(id: "z1", region: cut.shown, zoomWidth: cut.image.width, zoomHeight: cut.image.height,
                                  screenshot: screenshot, screenshotTaken: Date())
        // Find the red mark in the zoom and map it back to the screen.
        let red = try #require(redCenter(cut.image))
        let screen = mapping.toScreen(red)
        #expect(abs(screen.x - 300) < 0.6 && abs(screen.y - 310) < 0.6)
    }

    @Test func retinaAndNegativeOriginGeometry() {
        // A window on a display left of and above the main one, at 2 px per pt.
        let left = CaptureGeometry(rect: CGRect(x: -1440, y: -300, width: 720, height: 450), pixelWidth: 1440, pixelHeight: 900)
        let point = left.toScreen(x: 720, y: 450)
        #expect(point == CGPoint(x: -1080, y: -75))
        #expect(left.toPixels(point) == CGPoint(x: 720, y: 450))
        let mapping = ZoomMapping(id: "z1", region: CGRect(x: 700, y: 440, width: 40, height: 20), zoomWidth: 160, zoomHeight: 80,
                                  screenshot: left, screenshotTaken: Date())
        #expect(mapping.toScreen(CGPoint(x: 80, y: 40)) == point)
    }

    private func redCenter(_ image: CGImage) -> CGPoint? {
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        var sx = 0.0, sy = 0.0, n = 0.0
        for y in 0..<height {
            for x in 0..<width {
                let i = (y * width + x) * 4
                if pixels[i] > 200, pixels[i + 1] < 80, pixels[i + 2] < 80 { sx += Double(x) + 0.5; sy += Double(y) + 0.5; n += 1 }
            }
        }
        // Rows in the buffer run top-down here (CGContext memory order).
        return n > 0 ? CGPoint(x: sx / n, y: sy / n) : nil
    }
}
