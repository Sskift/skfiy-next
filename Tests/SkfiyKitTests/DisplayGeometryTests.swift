import CoreGraphics
import Foundation
import Testing
@testable import SkfiyKit

/// Layouts this Mac does not have: a 1× display left of the Retina main one
/// (negative x), another above it (negative y).
struct DisplayGeometryTests {
    let main = DisplayInfo(frame: CGRect(x: 0, y: 0, width: 1728, height: 1117), scale: 2)
    let left = DisplayInfo(frame: CGRect(x: -1920, y: 0, width: 1920, height: 1080), scale: 1)
    let above = DisplayInfo(frame: CGRect(x: 200, y: -1440, width: 2560, height: 1440), scale: 2)
    var all: [DisplayInfo] { [main, left, above] }

    @Test func windowsFindTheirDisplayAndScale() {
        #expect(display(for: CGRect(x: 100, y: 100, width: 800, height: 600), among: all) == main)
        #expect(backingScale(for: CGRect(x: -1500, y: 200, width: 700, height: 500), displays: all) == 1)
        #expect(backingScale(for: CGRect(x: 600, y: -900, width: 900, height: 600), displays: all) == 2)
        // Spanning two displays: the one holding the center.
        #expect(display(for: CGRect(x: -500, y: 100, width: 800, height: 400), among: all) == left)
        #expect(display(for: CGRect(x: -300, y: 100, width: 800, height: 400), among: all) == main)
        // Off every display: the nearest one.
        #expect(display(for: CGRect(x: -4000, y: 300, width: 200, height: 200), among: all) == left)
    }

    @Test func screenshotCoordinatesOnNegativeAndMixedScaleDisplays() {
        // A window on the 1× left display, captured at its own 1 px per point.
        let onLeft = CaptureGeometry(rect: CGRect(x: -1500, y: 200, width: 700, height: 500), pixelWidth: 700, pixelHeight: 500)
        #expect(onLeft.toScreen(x: 350, y: 250) == CGPoint(x: -1150, y: 450))
        #expect(onLeft.toPixels(CGPoint(x: -1150, y: 450)) == CGPoint(x: 350, y: 250))
        // The same window moved to the Retina display above, zoomed at that display's 2×.
        let onAbove = CaptureGeometry(rect: CGRect(x: 600, y: -900, width: 700, height: 500), pixelWidth: 700, pixelHeight: 500)
        let native = backingScale(for: onAbove.rect, displays: all) / onAbove.scale
        #expect(native == 2)
        let zoom = ZoomMapping(id: "z1", region: CGRect(x: 300, y: 200, width: 100, height: 100), zoomWidth: 200, zoomHeight: 200,
                               screenshot: onAbove, screenshotTaken: Date())
        #expect(zoom.toScreen(CGPoint(x: 100, y: 100)) == CGPoint(x: 950, y: -650))
        // A screenshot taken on one display does not describe the window after it moved to another.
        #expect(onLeft.toScreen(x: 350, y: 250) != onAbove.toScreen(x: 350, y: 250))
    }

    @Test func downscaledScreenshotsOfLargeWindows() {
        // A 2560-pt window on the external display, sent to the model at 1568 px wide.
        let scale = captureScale(for: CGSize(width: 2560, height: 1400))
        let geometry = CaptureGeometry(rect: CGRect(x: 200, y: -1440, width: 2560, height: 1400),
                                       pixelWidth: Int((2560 * scale).rounded()), pixelHeight: Int((1400 * scale).rounded()))
        let corner = geometry.toScreen(x: Double(geometry.pixelWidth), y: Double(geometry.pixelHeight))
        #expect(abs(corner.x - 2760) < 1.5 && abs(corner.y - -40) < 1.5)
        let back = geometry.toPixels(geometry.toScreen(x: 400, y: 300))
        #expect(abs(back.x - 400) < 1e-9 && abs(back.y - 300) < 1e-9)
    }
}
