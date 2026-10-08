import CoreGraphics
import Foundation
import Testing
@testable import SkfiyKit

struct GeometryTests {
    @Test func independentlyRoundedImageDimensionsMapEachAxis() {
        let geometry = CaptureGeometry(rect: CGRect(x: -40, y: 20, width: 1001, height: 667), pixelWidth: 500, pixelHeight: 333)
        let point = geometry.toScreen(x: 250, y: 166.5)
        #expect(point == CGPoint(x: 460.5, y: 353.5))
        #expect(geometry.toPixels(point) == CGPoint(x: 250, y: 166.5))
    }
    @Test func pointResolutionMapsOneToOne() {
        let geometry = CaptureGeometry(rect: CGRect(x: 100, y: 50, width: 800, height: 600), pixelWidth: 800, pixelHeight: 600)
        #expect(geometry.scale == 1)
        #expect(geometry.toScreen(x: 10, y: 20) == CGPoint(x: 110, y: 70))
        #expect(geometry.toPixels(CGPoint(x: 110, y: 70)) == CGPoint(x: 10, y: 20))
    }

    @Test func downscaledCaptureMapsBack() {
        let geometry = CaptureGeometry(rect: CGRect(x: 0, y: 25, width: 2000, height: 1000), pixelWidth: 1000, pixelHeight: 500)
        #expect(geometry.scale == 0.5)
        #expect(geometry.toScreen(x: 500, y: 250) == CGPoint(x: 1000, y: 525))
        #expect(geometry.containsPixel(x: 1000, y: 500))
        #expect(!geometry.containsPixel(x: 1001, y: 10))
        #expect(!geometry.containsPixel(x: -1, y: 10))
    }

    @Test func captureScaleRespectsModelLimits() {
        #expect(captureScale(for: CGSize(width: 800, height: 600)) == 1)
        let wide = captureScale(for: CGSize(width: 3136, height: 400))
        #expect(abs(wide - 0.5) < 0.0001)
        let big = captureScale(for: CGSize(width: 1512, height: 982))
        #expect(1512 * big <= 1568)
        #expect(1512 * big * 982 * big <= 1_150_000.5)
    }
}

struct CaptureScaleTests {
    @Test func screenshotsStayAtOnePixelPerPointButZoomsUseTheDisplay() {
        #expect(captureScale(for: CGSize(width: 800, height: 600)) == 1)
        #expect(captureScale(for: CGSize(width: 200, height: 100), maxScale: 2) == 2)
        // A large window is scaled down to the size limits either way.
        #expect(captureScale(for: CGSize(width: 3136, height: 1000), maxScale: 2) == 0.5)
    }
}

struct AppMatchingTests {
    let apps = [
        AppRecord(name: "TextEdit", bundleID: "com.apple.TextEdit", path: "/System/Applications/TextEdit.app", aliases: ["TextEdit"], pid: 10),
        AppRecord(name: "计算器", bundleID: "com.apple.calculator", path: "/System/Applications/Calculator.app", aliases: ["Calculator"]),
        AppRecord(name: "Google Chrome", bundleID: "com.google.Chrome", path: "/Applications/Google Chrome.app", pid: 11),
        AppRecord(name: "Google Chrome Canary", bundleID: "com.google.Chrome.canary", path: "/Applications/Google Chrome Canary.app"),
        AppRecord(name: "Notes", bundleID: "com.apple.Notes", pid: 12),
        AppRecord(name: "Notes", bundleID: "com.apple.Notes", pid: 13, isFrontmost: true)
    ]

    @Test func matchesBundleIDNameAliasAndPath() {
        #expect(matchApp("com.apple.textedit", in: apps) == .one(apps[0]))
        #expect(matchApp("textedit", in: apps) == .one(apps[0]))
        #expect(matchApp("TextEdit.app", in: apps) == .one(apps[0]))
        #expect(matchApp("Calculator", in: apps) == .one(apps[1]))
        #expect(matchApp("计算器", in: apps) == .one(apps[1]))
        #expect(matchApp("/System/Applications/TextEdit.app", in: apps) == .one(apps[0]))
    }

    @Test func exactNameBeatsPrefix() {
        #expect(matchApp("Google Chrome", in: apps) == .one(apps[2]))
        #expect(matchApp("chrome", in: apps) == .ambiguous([apps[2], apps[3]]))
    }

    @Test func prefersFrontmostInstanceOfTheSameApp() {
        #expect(matchApp("Notes", in: apps) == .one(apps[5]))
    }

    @Test func prefersTheRegularAppOverAHelperWithTheSameName() {
        let wechat = AppRecord(name: "WeChat", bundleID: "com.tencent.xinWeChat", pid: 20)
        let helper = AppRecord(name: "WeChat", bundleID: "com.tencent.flue.WeChatAppEx", pid: 21, isRegular: false)
        #expect(matchApp("WeChat", in: [helper, wechat]) == .one(wechat))
        let other = AppRecord(name: "WeChat", bundleID: "com.example.other", pid: 22)
        #expect(matchApp("WeChat", in: [helper, wechat, other]) == .ambiguous([helper, wechat, other]))
    }

    /// RustDesk runs `RustDesk --server` (accessory, no windows) next to its UI
    /// process under the same bundle id; the UI process must win.
    @Test func prefersTheRegularInstanceOfTheSameBundle() {
        let server = AppRecord(name: "RustDesk", bundleID: "com.carriez.rustdesk", path: "/Applications/RustDesk.app", pid: 1199, isRegular: false)
        let ui = AppRecord(name: "RustDesk", bundleID: "com.carriez.rustdesk", path: "/Applications/RustDesk.app", pid: 96984)
        #expect(matchApp("RustDesk", in: [server, ui]) == .one(ui))
        #expect(matchApp("com.carriez.rustdesk", in: [server, ui]) == .one(ui))
        #expect(matchApp("/Applications/RustDesk.app", in: [server, ui]) == .one(ui))
        // A frontmost instance still wins.
        let frontServer = AppRecord(name: "RustDesk", bundleID: "com.carriez.rustdesk", pid: 1199, isFrontmost: true, isRegular: false)
        #expect(matchApp("RustDesk", in: [ui, frontServer]) == .one(frontServer))
    }

    @Test func recognizesTerminals() {
        #expect(isTerminal(bundleID: "com.mitchellh.ghostty"))
        #expect(isTerminal(bundleID: "com.apple.Terminal"))
        #expect(isTerminal(bundleID: "com.googlecode.iterm2"))
        #expect(!isTerminal(bundleID: "com.apple.TextEdit"))
        #expect(!isTerminal(bundleID: nil))
    }

    @Test func ancestorsIncludeThisProcess() {
        let pids = ancestorProcessIDs()
        #expect(pids.contains(getpid()))
        #expect(pids.contains(getppid()))
    }

    @Test func unknownAppIsNone() {
        #expect(matchApp("Photoshop", in: apps) == .none)
        #expect(matchApp("  ", in: apps) == .none)
    }
}

struct TextLocationTests {
    @Test func findsUniqueText() throws {
        let range = try locateText("world", in: "hello world", prefix: "", suffix: "")
        #expect(range == NSRange(location: 6, length: 5))
    }

    @Test func disambiguatesWithPrefixAndSuffix() throws {
        let content = "cat, dog, cat."
        #expect(throws: ToolError.self) { try locateText("cat", in: content, prefix: "", suffix: "") }
        #expect(try locateText("cat", in: content, prefix: "dog, ", suffix: "") == NSRange(location: 10, length: 3))
        #expect(try locateText("cat", in: content, prefix: "", suffix: ",") == NSRange(location: 0, length: 3))
    }

    @Test func usesUTF16Offsets() throws {
        // "😀" is two UTF-16 units; AX text ranges count UTF-16 units.
        #expect(try locateText("你好", in: "😀 你好", prefix: "", suffix: "") == NSRange(location: 3, length: 2))
    }

    @Test func reportsMissingText() {
        #expect(throws: ToolError.self) { try locateText("zzz", in: "abc", prefix: "", suffix: "") }
    }
}
