import CoreGraphics
import Foundation
import Testing
@testable import SkfiyKit

/// Windows that are not on top: where pointer input is routed, whether a
/// window is fully covered, what kind of window cannot take pixels, remote
/// sessions, and the facts the capability report gets from them.
struct WindowTargetingTests {
    private func row(_ id: Int, _ rect: CGRect, layer: Int = 0, alpha: Double = 1, owner: Int = 500) -> [String: Any] {
        [kCGWindowNumber as String: id, kCGWindowLayer as String: layer, kCGWindowAlpha as String: alpha,
         kCGWindowOwnerPID as String: owner, kCGWindowBounds as String: rect.dictionaryRepresentation as NSDictionary]
    }

    private let display = CGRect(x: 0, y: 0, width: 1512, height: 982)

    // MARK: Pointer routing

    @Test func inspectedWindowUnderASiblingGetsThePointer() {
        let shown = CGRect(x: 100, y: 100, width: 400, height: 300)
        // Another normal window of the app is on top at the point: the model saw the inspected window alone.
        #expect(routePointerWindow(shown: 7, shownBounds: shown, independent: true, top: 9, topIsSiblingWindow: true, point: CGPoint(x: 200, y: 200)) == 7)
        // A menu, pop-up or sheet over it still gets it, as on screen.
        #expect(routePointerWindow(shown: 7, shownBounds: shown, independent: true, top: 11, topIsSiblingWindow: false, point: CGPoint(x: 200, y: 200)) == 11)
        // Outside the inspected window: the app's topmost window there.
        #expect(routePointerWindow(shown: 7, shownBounds: shown, independent: true, top: 9, topIsSiblingWindow: true, point: CGPoint(x: 600, y: 200)) == 9)
        // Nothing of the app's on top there: the inspected window.
        #expect(routePointerWindow(shown: 7, shownBounds: shown, independent: true, top: nil, topIsSiblingWindow: false, point: CGPoint(x: 200, y: 200)) == 7)
    }

    @Test func compositeScreenshotsKeepTheTopmostWindow() {
        // A region screenshot showed whatever window of the app lay on top, so that one is meant.
        let shown = CGRect(x: 100, y: 100, width: 400, height: 300)
        #expect(routePointerWindow(shown: 7, shownBounds: shown, independent: false, top: 9, topIsSiblingWindow: true, point: CGPoint(x: 200, y: 200)) == 9)
        #expect(routePointerWindow(shown: nil, shownBounds: nil, independent: false, top: 9, topIsSiblingWindow: true, point: CGPoint(x: 200, y: 200)) == 9)
    }

    // MARK: Coverage

    @Test func subtractsCoveringRectangles() {
        let window = CGRect(x: 0, y: 0, width: 100, height: 100)
        #expect(uncoveredParts(of: window, under: [CGRect(x: -10, y: -10, width: 200, height: 200)]).isEmpty)
        let left = uncoveredParts(of: window, under: [CGRect(x: 0, y: 0, width: 60, height: 100), CGRect(x: 60, y: 0, width: 40, height: 99)])
        #expect(left == [CGRect(x: 60, y: 99, width: 40, height: 1)])
        let area = uncoveredParts(of: window, under: [CGRect(x: 25, y: 25, width: 50, height: 50)]).reduce(0) { $0 + $1.width * $1.height }
        #expect(area == CGFloat(7_500))
    }

    @Test func fullyCoveredOnlyWhenNoPointShows() {
        let target = CGRect(x: 430, y: 190, width: 600, height: 400)
        let rows = [
            row(1, CGRect(x: 0, y: 0, width: 1512, height: 33), layer: 25, owner: 1),          // menu bar strip
            row(2, display, layer: 20, owner: 2),                                                // the Dock's transparent canvas
            row(3, CGRect(x: 300, y: 100, width: 900, height: 700)),                           // the user's window over it
            row(4, CGRect(x: 0, y: 0, width: 50, height: 50), alpha: 0),                         // invisible
            row(5, target, owner: 900)
        ]
        #expect(isFullyCovered(5, rows: rows, displays: [display]) == true)
        // One corner out from under the user's window: Chromium still draws it.
        let corner = [row(3, CGRect(x: 300, y: 100, width: 900, height: 700)), row(5, CGRect(x: 0, y: 33, width: 600, height: 400), owner: 900)]
        #expect(isFullyCovered(5, rows: corner, displays: [display]) == false)
        // skfiy's own cursor overlay hides nothing.
        let cursor = [row(6, target, owner: 77), row(5, target, owner: 900)]
        #expect(isFullyCovered(5, rows: cursor, displays: [display], ignoredOwners: [77], cornerRadius: 0) == false)
        #expect(isFullyCovered(5, rows: cursor, displays: [display], cornerRadius: 0) == true)
        // A window exactly as large as the one above it shows at that one's rounded corners.
        #expect(isFullyCovered(5, rows: cursor, displays: [display]) == false)
        // A part off every display shows nowhere.
        let offDisplay = [row(3, CGRect(x: 1000, y: 0, width: 512, height: 982)), row(5, CGRect(x: 1100, y: 100, width: 800, height: 300), owner: 900)]
        #expect(isFullyCovered(5, rows: offDisplay, displays: [display]) == true)
        // Not on screen at all: unknown.
        #expect(isFullyCovered(99, rows: rows, displays: [display]) == nil)
    }

    // MARK: Windows that cannot take pixels

    @Test func classifiesWindowsThatAreNotOnScreen() {
        #expect(WindowPresence.classify(onScreen: true, listedByApp: true, minimized: false, appHidden: false) == .onScreen)
        #expect(WindowPresence.classify(onScreen: false, listedByApp: true, minimized: true, appHidden: true) == .minimized)
        #expect(WindowPresence.classify(onScreen: false, listedByApp: true, minimized: false, appHidden: true) == .appHidden)
        #expect(WindowPresence.classify(onScreen: false, listedByApp: true, minimized: false, appHidden: false) == .otherDesktop)
        // A closed window can live on in the window server; the app no longer lists it.
        #expect(WindowPresence.classify(onScreen: false, listedByApp: false, minimized: false, appHidden: true) == .closed)
    }

    @Test func refusalsSayWhatIsWrong() {
        let minimized = WindowPresence.minimized.refusal(window: "alpha.txt", id: 15440, app: "TextEdit") ?? ""
        #expect(minimized.contains("\"alpha.txt\" (id 15440) is minimized") && minimized.contains("Nothing was sent") && !minimized.contains("closed"))
        let hidden = WindowPresence.appHidden.refusal(window: "", id: nil, app: "SkfiyScenario") ?? ""
        #expect(hidden.hasPrefix("SkfiyScenario is hidden") && hidden.contains("element_index"))
        #expect(WindowPresence.otherDesktop.refusal(window: "Notes", id: 3, app: "Notes")?.contains("another desktop") == true)
        #expect(WindowPresence.closed.refusal(window: "", id: 3, app: "Notes")?.hasPrefix("The window (id 3) closed") == true)
        #expect(WindowPresence.onScreen.refusal(window: "", id: 3, app: "Notes") == nil)
    }

    // MARK: Remote sessions, Flutter, app queries

    @Test func recognizesRustDeskRemoteSessions() {
        let rustdesk = "com.carriez.rustdesk"
        #expect(RemoteSurface.isRemoteSession(bundleID: rustdesk, title: "100.110.238.106:51223@desktop-4k6g72o - Remote Desktop - RustDesk"))
        #expect(RemoteSurface.isRemoteSession(bundleID: "com.carriez.RustDesk", title: "123456789 - View Camera - RustDesk"))
        #expect(!RemoteSurface.isRemoteSession(bundleID: rustdesk, title: "RustDesk"))
        #expect(!RemoteSurface.isRemoteSession(bundleID: rustdesk, title: "123456789 - File Transfer - RustDesk"))
        #expect(!RemoteSurface.isRemoteSession(bundleID: "com.apple.TextEdit", title: "Remote Desktop - notes.txt"))
        #expect(RemoteSurface.refusal("x - Remote Desktop - RustDesk", what: "a click").contains("run_in_front"))
    }

    @Test func detectsFlutterBundles() throws {
        let bundle = FileManager.default.temporaryDirectory.appendingPathComponent("skfiy-flutter-\(UUID().uuidString).app")
        defer { try? FileManager.default.removeItem(at: bundle) }
        #expect(!isFlutter(bundlePath: bundle.path))
        try FileManager.default.createDirectory(at: bundle.appendingPathComponent("Contents/Frameworks/FlutterMacOS.framework"), withIntermediateDirectories: true)
        #expect(isFlutter(bundlePath: bundle.path))
        #expect(!isFlutter(bundlePath: nil))
    }

    @Test func parsesProcessIDQueries() {
        #expect(parsePIDQuery("pid:96984") == 96984)
        #expect(parsePIDQuery(" PID 1199 ") == 1199)
        #expect(parsePIDQuery("pid=42") == 42)
        #expect(parsePIDQuery("pid:") == nil)
        #expect(parsePIDQuery("pidgin") == nil)
        #expect(parsePIDQuery("RustDesk") == nil)
        #expect(parsePIDQuery("pid:-3") == nil)
    }

    // MARK: Keyboard

    @Test func keyboardTargetNamesBothWindows() {
        var target = KeyboardTarget()
        #expect(target.reachesIntended)
        target.intended = 15101
        target.intendedTitle = "Second"
        target.keyWindow = 15095
        target.keyTitle = "Scenario main"
        target.why = "; it has no focused text field for skfiy to make it the key window with"
        #expect(!target.reachesIntended)
        let refusal = target.refusal(app: "SkfiyScenario")
        #expect(refusal.contains("\"Scenario main\" (id 15095)") && refusal.contains("\"Second\" (id 15101)") && refusal.contains("Nothing was sent"))
        target.keyWindow = 15101
        #expect(target.reachesIntended)
    }

    @Test func keysFollowANewWindowButNotAnOldOne() {
        let known: Set<CGWindowID> = [10, 11]
        // cmd+n (or a dialog) opened window 12 and it took the keyboard: keys belong to it.
        #expect(keyWindowMoved(now: 12, inspected: 10, known: known))
        // A window that was already open became key again: the inspected one is made key again.
        #expect(!keyWindowMoved(now: 11, inspected: 10, known: known))
        // The inspected window itself, or no key window, or nothing known yet.
        #expect(!keyWindowMoved(now: 10, inspected: 10, known: known))
        #expect(!keyWindowMoved(now: nil, inspected: 10, known: known))
        #expect(!keyWindowMoved(now: 12, inspected: 10, known: []))
    }

    @Test func refusalsDoNotSuggestWhatCannotWork() {
        var target = KeyboardTarget()
        target.intended = 20
        target.intendedTitle = "Notes"
        target.keyWindow = 21
        target.keyTitle = "Untitled"
        #expect(target.refusal(app: "TextEdit").contains("Click a text field of that window first"))
        // Hidden app or minimized window: a click cannot make it the key window.
        target.clickCanMakeKey = false
        #expect(!target.refusal(app: "TextEdit").contains("Click a text field"))
        let moved = target.movedRefusal(app: "TextEdit")
        #expect(moved.contains("\"Untitled\" (id 21)") && moved.contains("window: \"21\"") && moved.contains("window: \"20\"") && moved.contains("Nothing was sent"))
    }

    // MARK: Verification and capabilities

    @Test func unobservableWindowIsNeverNoEffect() async {
        var expectation = ActionExpectation()
        expectation.text = "Clicks: 2"
        expectation.timeout = 1
        var frozen = VerifyObservation(text: "Clicks: 1", windows: ["1": "Electron"], targetPresent: true)
        frozen.unobservable = "the window is completely covered by other windows, and Chromium does not update a covered window"
        var time = 0.0
        let verdict = await expectation.verify(before: frozen, now: { time }, sleep: { time += $0 }, observe: { frozen })
        #expect(verdict.status == .timeout)
        #expect(verdict.detail.contains("whether it took effect is unknown"))
    }

    @Test func capabilitiesExplainWindowsThatAreNotOnTop() {
        var facts = CapabilityInputs(session: .unlocked, mode: .normal, appName: "RustDesk")
        facts.pid = 96984
        facts.bundleID = "com.carriez.rustdesk"
        facts.windows = [.init(id: 13119, title: "RustDesk"), .init(id: 14881, title: "peer - Remote Desktop - RustDesk")]
        facts.inspected = facts.windows[0]
        facts.accessibilityElements = 0
        facts.flutter = true
        facts.remoteKeyWindow = true
        facts.keyWindowElsewhere = "peer - Remote Desktop - RustDesk (id 14881)"
        var report = CapabilityReport.evaluate(facts)
        #expect(report["ax"]?.available == true && report["ax"]?.detail.contains("Flutter") == true)
        #expect(report["keyboard"]?.available == false && report["keyboard"]?.detail.contains("remote session") == true)
        #expect(report["pointer"]?.limits.contains { $0.contains("Flutter ignores background mouse clicks") } == true)

        facts.inspected = facts.windows[1]
        facts.remoteSession = true
        report = CapabilityReport.evaluate(facts)
        #expect(report["pointer"]?.available == false && report["screenshot"]?.available == true)
        #expect(report["pointer"]?.limits.contains(RemoteSurface.foregroundCaveat) == true)
        #expect(report["keyboard"]?.limits.contains(RemoteSurface.foregroundCaveat) == true)
        facts.frontmost = true
        report = CapabilityReport.evaluate(facts)
        #expect(report["foreground"]?.available == false)
        #expect(report["foreground"]?.detail.contains("press_key reaches it directly") == false)

        var other = CapabilityInputs(session: .unlocked, mode: .normal, appName: "TextEdit")
        other.pid = 7
        other.windows = [.init(id: 1, title: "beta.txt"), .init(id: 2, title: "alpha.txt")]
        other.inspected = other.windows[1]
        other.accessibilityElements = 10
        other.keyWindowElsewhere = "beta.txt (id 1)"
        #expect(CapabilityReport.evaluate(other)["keyboard"]?.limits.contains { $0.contains("Keys go to the app's key window \"beta.txt (id 1)\"") } == true)

        var electron = CapabilityInputs(session: .unlocked, mode: .normal, appName: "Electron")
        electron.pid = 8
        electron.chromium = true
        electron.windows = [.init(id: 3, title: "probe")]
        electron.inspected = electron.windows[0]
        electron.accessibilityElements = 0
        electron.coveredChromium = true
        let covered = CapabilityReport.evaluate(electron)
        #expect(covered["screenshot"]?.limits.contains { $0.contains("completely covered") } == true)
        #expect(covered["ax"]?.limits.contains { $0.contains("uncovering any corner") } == true)
    }
}
